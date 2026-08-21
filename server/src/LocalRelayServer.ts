import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import { hasExactKeys, isSafeInteger } from '../../assets/scripts/shared/CanonicalMath';
import {
    checkpointHash,
    cloneCheckpoint,
    validateCheckpoint,
} from '../../assets/scripts/shared/CheckpointCodec';
import {
    ClientEnvelope,
    MatchPreparePayload,
    RoomState,
    ServerEnvelope,
    ShotCommitPayload,
    ShotIntentPayload,
    TurnPhase,
    TurnResolutionPayload,
    TurnSettledPayload,
    expectedCampForTurn,
    isHash8,
    isRoomCode,
    isUuid,
} from '../../assets/scripts/shared/PvpProtocol';
import {
    INITIAL_CHECKPOINT,
    PVP_PROTOCOL_VERSION,
    PVP_RULESET_VERSION,
    RULESET_MANIFEST,
    verifyRulesetManifest,
} from '../../assets/scripts/shared/RulesetManifest';
import { validateShotCommandQ } from '../../assets/scripts/shared/ShotCommandCodec';
import { CheckpointV1, PvpCamp, PvpRole } from '../../assets/scripts/shared/PvpTypes';

const PORT = Number(process.env.ARCSHOT_RELAY_PORT || 8081);
const MAX_MESSAGE_BYTES = 64 * 1024;
const READY_TIMEOUT_MS = 10_000;
const RESULT_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const CLOSED_ABORT_TTL_MS = 10_000;
const FINISHED_TTL_MS = 60_000;

type TimerName = 'READY' | 'RESULT' | 'APPLY' | 'TTL';

interface ProcessedRequest {
    digest: string;
    type: string;
}

interface ConnectionContext {
    socket: WebSocket;
    connectionId: string;
    sessionId: string;
    clientInstanceId: string;
    rulesetVersion: string;
    helloComplete: boolean;
    roomCode: string;
    role: PvpRole | null;
    camp: PvpCamp | null;
    expectedClientSeq: number;
    serverSeq: number;
    lastActivityAt: number;
    rateTimestamps: number[];
    processed: Map<number, ProcessedRequest>;
    simulatedLatencyMs: number;
    lastScheduledSendAt: number;
}

interface PendingResolution {
    payload: TurnResolutionPayload;
    applied: Set<string>;
}

interface Room {
    roomCode: string;
    roomState: RoomState;
    turnPhase: TurnPhase;
    matchId: string;
    host: ConnectionContext;
    guest: ConnectionContext | null;
    turnIndex: number;
    expectedCamp: PvpCamp;
    confirmedCheckpoint: CheckpointV1;
    confirmedStateHash: string;
    activeCommit: ShotCommitPayload | null;
    settled: Map<string, TurnSettledPayload>;
    ready: Set<string>;
    pendingResolution: PendingResolution | null;
    lastCompletedResolution: TurnResolutionPayload | null;
    timers: Map<TimerName, ReturnType<typeof setTimeout>>;
    createdAtServerMono: number;
    lastActivityAtServerMono: number;
}

const connections = new Map<string, ConnectionContext>();
const rooms = new Map<string, Room>();

if (verifyRulesetManifest().length > 0) {
    throw new Error(`RULESET_MANIFEST_INVALID:${verifyRulesetManifest().join(',')}`);
}

const httpServer = createServer(handleHttp);
const webSocketServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

webSocketServer.on('connection', (socket, request) => {
    const latency = parseLatency(request);
    const context: ConnectionContext = {
        socket,
        connectionId: randomUUID(),
        sessionId: randomUUID(),
        clientInstanceId: '',
        rulesetVersion: '',
        helloComplete: false,
        roomCode: '',
        role: null,
        camp: null,
        expectedClientSeq: 1,
        serverSeq: 0,
        lastActivityAt: monotonicMs(),
        rateTimestamps: [],
        processed: new Map(),
        simulatedLatencyMs: latency,
        lastScheduledSendAt: 0,
    };
    connections.set(context.connectionId, context);

    socket.on('message', data => receiveMessage(context, data));
    socket.on('close', () => disconnect(context, 'PEER_DISCONNECTED'));
    socket.on('error', error => {
        console.error('[ArcShot Relay] socket error', context.connectionId, error.message);
    });
});

const heartbeatTimer = setInterval(() => {
    const now = monotonicMs();
    for (const context of connections.values()) {
        if (now - context.lastActivityAt > HEARTBEAT_TIMEOUT_MS) {
            sendError(context, null, 'PROTOCOL_FATAL', true, 'Heartbeat timeout');
            context.socket.close(4000, 'HEARTBEAT_TIMEOUT');
        }
    }
}, 5_000);
heartbeatTimer.unref();

httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[ArcShot Relay] protocol=${PVP_PROTOCOL_VERSION}`);
    console.log(`[ArcShot Relay] ruleset=${PVP_RULESET_VERSION}`);
    console.log(`[ArcShot Relay] ws://127.0.0.1:${PORT}`);
    console.log(`[ArcShot Relay] diagnostics=http://127.0.0.1:${PORT}/diagnostics`);
});

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/diagnostics') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({
            protocolVersion: PVP_PROTOCOL_VERSION,
            rulesetVersion: PVP_RULESET_VERSION,
            activeConnectionCount: connections.size,
            activeRoomCount: rooms.size,
            activeDeadlineTimerCount: Array.from(rooms.values())
                .reduce((sum, room) => sum + room.timers.size, 0),
        }));
        return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('ArcShot local relay is running.');
}

function parseLatency(request: IncomingMessage): number {
    try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
        const value = Number(url.searchParams.get('latency') ?? 0);
        return [0, 100, 300, 500].indexOf(value) >= 0 ? value : 0;
    } catch {
        return 0;
    }
}

function receiveMessage(context: ConnectionContext, raw: RawData): void {
    context.lastActivityAt = monotonicMs();
    const now = context.lastActivityAt;
    context.rateTimestamps.push(now);
    context.rateTimestamps = context.rateTimestamps.filter(time => now - time <= 3_000);
    if (context.rateTimestamps.length > 90) {
        sendError(context, null, 'RATE_LIMIT', true, 'More than 30 messages/sec for 3 seconds');
        abortConnectionRoom(context, 'PROTOCOL_FATAL', 'RATE_LIMIT');
        context.socket.close(4008, 'RATE_LIMIT');
        return;
    }

    const text = raw.toString();
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
        sendError(context, null, 'MESSAGE_TOO_LARGE', true, 'Message exceeds 64 KiB');
        context.socket.close(4009, 'MESSAGE_TOO_LARGE');
        return;
    }

    let envelope: ClientEnvelope;
    try {
        envelope = JSON.parse(text) as ClientEnvelope;
    } catch {
        sendError(context, null, 'MALFORMED_JSON', false, 'Invalid JSON');
        return;
    }
    if (jsonDepth(envelope) > 6 || !isClientEnvelope(envelope)) {
        sendError(context, null, 'MALFORMED_JSON', false, 'Envelope schema invalid');
        return;
    }
    if (envelope.protocolVersion !== PVP_PROTOCOL_VERSION) {
        sendError(context, envelope.clientSeq, 'PROTOCOL_MISMATCH', true, 'Protocol version mismatch');
        abortConnectionRoom(context, 'PROTOCOL_FATAL', 'PROTOCOL_MISMATCH');
        return;
    }
    if (envelope.clientSeq > context.expectedClientSeq) {
        sendError(context, envelope.clientSeq, 'SEQUENCE_GAP', true, 'Client sequence gap');
        abortConnectionRoom(context, 'PROTOCOL_FATAL', 'SEQUENCE_GAP');
        return;
    }

    const digest = `${envelope.type}|${stableJson(envelope.payload)}`;
    if (envelope.clientSeq < context.expectedClientSeq) {
        const previous = context.processed.get(envelope.clientSeq);
        if (!previous || previous.digest !== digest) {
            sendError(context, envelope.clientSeq, 'INVALID_STATE', true, 'Repeated sequence payload conflict');
            abortConnectionRoom(context, 'PROTOCOL_FATAL', 'SEQUENCE_CONFLICT');
            return;
        }
        handleDuplicate(context, envelope);
        return;
    }

    context.expectedClientSeq += 1;
    context.processed.set(envelope.clientSeq, { digest, type: envelope.type });
    while (context.processed.size > 64) {
        const first = context.processed.keys().next().value as number | undefined;
        if (first === undefined) break;
        context.processed.delete(first);
    }
    dispatch(context, envelope);
}

function dispatch(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (envelope.type === 'HELLO') return handleHello(context, envelope);
    if (!context.helloComplete) {
        sendError(context, envelope.clientSeq, 'HELLO_REQUIRED', false, 'HELLO must be first');
        return;
    }
    switch (envelope.type) {
        case 'JOIN_ROOM': handleJoinRoom(context, envelope); break;
        case 'LEAVE_ROOM': handleLeaveRoom(context, envelope); break;
        case 'MATCH_READY': handleMatchReady(context, envelope); break;
        case 'SHOT_INTENT': handleShotIntent(context, envelope); break;
        case 'TURN_SETTLED': handleTurnSettled(context, envelope); break;
        case 'TURN_RESOLUTION_APPLIED': handleResolutionApplied(context, envelope); break;
        case 'PING': handlePing(context, envelope); break;
        default: sendError(context, envelope.clientSeq, 'UNKNOWN_TYPE', false, envelope.type);
    }
}

function handleHello(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (context.helloComplete) {
        sendError(context, envelope.clientSeq, 'HELLO_DUPLICATE', false, 'HELLO already completed');
        return;
    }
    if (!exactPayload(envelope.payload, ['clientInstanceId', 'rulesetVersion'])) {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'HELLO payload invalid');
        return;
    }
    const payload = envelope.payload as { clientInstanceId: unknown; rulesetVersion: unknown };
    if (!isUuid(payload.clientInstanceId)) {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'clientInstanceId invalid');
        return;
    }
    if (payload.rulesetVersion !== PVP_RULESET_VERSION) {
        sendError(context, envelope.clientSeq, 'RULESET_MISMATCH', true, 'Ruleset version mismatch');
        return;
    }
    context.clientInstanceId = payload.clientInstanceId;
    context.rulesetVersion = payload.rulesetVersion;
    context.helloComplete = true;
    send(context, 'HELLO_ACK', { sessionId: context.sessionId });
}

function handleJoinRoom(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (!exactPayload(envelope.payload, ['roomCode'])) {
        sendError(context, envelope.clientSeq, 'INVALID_ROOM_CODE', false, 'JOIN_ROOM payload invalid');
        return;
    }
    const roomCode = (envelope.payload as { roomCode: unknown }).roomCode;
    if (!isRoomCode(roomCode)) {
        sendError(context, envelope.clientSeq, 'INVALID_ROOM_CODE', false, 'Room code must be 6 digits');
        return;
    }
    if (context.roomCode) {
        sendError(context, envelope.clientSeq, 'ALREADY_IN_ROOM', false, 'Connection already belongs to a room');
        return;
    }

    let room = rooms.get(roomCode);
    if (!room) {
        room = createRoom(roomCode, context);
        rooms.set(roomCode, room);
        attach(context, roomCode, 'HOST', 'RED');
        send(context, 'ROOM_WAITING', { roomCode, localRole: 'HOST', localCamp: 'RED' });
        return;
    }
    if (room.roomState !== 'WAITING' || room.guest) {
        sendError(context, envelope.clientSeq, 'ROOM_FULL', false, 'Room already has two players');
        return;
    }

    room.guest = context;
    room.matchId = randomUUID();
    room.roomState = 'STARTING';
    room.lastActivityAtServerMono = monotonicMs();
    attach(context, roomCode, 'GUEST', 'BLUE');
    sendMatchPrepare(room, room.host);
    sendMatchPrepare(room, context);
    scheduleRoomTimer(room, 'READY', READY_TIMEOUT_MS, () => {
        abortRoom(room!, 'READY_TIMEOUT', 'Both clients did not become ready');
    });
}

function handleLeaveRoom(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (!exactPayload(envelope.payload, ['reason'])) {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'LEAVE_ROOM payload invalid');
        return;
    }
    const reason = (envelope.payload as { reason: unknown }).reason;
    if (reason !== 'USER' && reason !== 'PAGE_HIDDEN') {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'LEAVE_ROOM reason invalid');
        return;
    }
    const room = getContextRoom(context);
    if (!room) {
        sendError(context, envelope.clientSeq, 'NOT_ROOM_MEMBER', false, 'Not in a room');
        return;
    }
    if (room.roomState === 'FINISHED' || room.roomState === 'ABORTED') {
        broadcast(room, 'ROOM_LEFT', {
            roomCode: room.roomCode,
            matchId: room.matchId || null,
            reason,
        });
        deleteRoom(room);
        return;
    }
    send(context, 'ROOM_LEFT', { roomCode: room.roomCode, matchId: room.matchId || null, reason });
    if (room.roomState === 'WAITING' && room.host === context) {
        deleteRoom(room);
    } else {
        abortRoom(room, reason === 'PAGE_HIDDEN' ? 'PAGE_HIDDEN' : 'USER_LEFT', reason);
    }
    detach(context);
}

function handleMatchReady(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (!exactPayload(envelope.payload, ['matchId', 'observedInitialHash'])) {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'MATCH_READY payload invalid');
        return;
    }
    const room = requireRoomState(context, envelope.clientSeq, 'STARTING');
    if (!room) return;
    const payload = envelope.payload as { matchId: unknown; observedInitialHash: unknown };
    if (payload.matchId !== room.matchId || payload.observedInitialHash !== RULESET_MANIFEST.initialStateHash) {
        abortRoom(room, 'READY_HASH_MISMATCH', 'Initial hash or matchId mismatch');
        return;
    }
    room.ready.add(context.connectionId);
    if (room.ready.size < 2) return;
    clearRoomTimer(room, 'READY');
    room.roomState = 'PLAYING';
    room.turnPhase = 'WAITING_SHOT';
    room.turnIndex = 0;
    room.expectedCamp = 'RED';
    broadcast(room, 'TURN_BEGIN', {
        matchId: room.matchId,
        turnIndex: 0,
        expectedCamp: 'RED',
        confirmedStateHash: room.confirmedStateHash,
    });
}

function handleShotIntent(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (!exactPayload(envelope.payload, [
        'roomCode', 'matchId', 'turnIndex', 'intentId', 'preStateHash',
        'directionXQ', 'directionYQ', 'pullRatioQ', 'curveRatioQ',
    ])) {
        sendError(context, envelope.clientSeq, 'INVALID_COMMAND', false, 'SHOT_INTENT payload invalid');
        return;
    }
    const room = requireRoomState(context, envelope.clientSeq, 'PLAYING');
    if (!room) return;
    const payload = envelope.payload as ShotIntentPayload;
    if (room.turnPhase !== 'WAITING_SHOT') {
        if (room.activeCommit && sameIntent(room.activeCommit, payload)) {
            send(context, 'SHOT_COMMIT', room.activeCommit);
        } else {
            sendError(context, envelope.clientSeq, 'TURN_ALREADY_COMMITTED', false, 'Turn already has a shot');
        }
        return;
    }
    if (context.camp !== room.expectedCamp) {
        sendError(context, envelope.clientSeq, 'NOT_YOUR_TURN', false, 'Wrong camp');
        return;
    }
    if (payload.roomCode !== room.roomCode || payload.matchId !== room.matchId
        || payload.turnIndex !== room.turnIndex || payload.preStateHash !== room.confirmedStateHash) {
        sendError(context, envelope.clientSeq, 'PRESTATE_HASH_MISMATCH', false, 'Shot pre-state mismatch');
        return;
    }
    if (!isUuid(payload.intentId) || validateShotCommandQ(commandPart(payload)).length > 0) {
        sendError(context, envelope.clientSeq, 'INVALID_COMMAND', false, 'Shot command invalid');
        return;
    }

    const commit: ShotCommitPayload = {
        ...payload,
        expectedCamp: room.expectedCamp,
        shotId: `${room.matchId}:${room.turnIndex}`,
    };
    room.activeCommit = commit;
    room.turnPhase = 'WAITING_RESULTS';
    room.settled.clear();
    broadcast(room, 'SHOT_COMMIT', commit);
    scheduleRoomTimer(room, 'RESULT', RESULT_TIMEOUT_MS, () => {
        abortRoom(room, 'RESULT_TIMEOUT', 'Both clients did not submit settled results');
    });
}

function handleTurnSettled(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (!exactPayload(envelope.payload, [
        'roomCode', 'matchId', 'completedTurnIndex', 'shotId', 'stateHash',
        'checkpoint', 'simulationStatus', 'errorCode',
    ])) {
        sendError(context, envelope.clientSeq, 'SNAPSHOT_INVALID', false, 'TURN_SETTLED payload invalid');
        return;
    }
    const room = requireRoomState(context, envelope.clientSeq, 'PLAYING');
    if (!room || room.turnPhase !== 'WAITING_RESULTS' || !room.activeCommit) {
        sendError(context, envelope.clientSeq, 'RESULT_NOT_EXPECTED', false, 'No result expected');
        return;
    }
    const payload = envelope.payload as TurnSettledPayload;
    if (payload.roomCode !== room.roomCode || payload.matchId !== room.matchId
        || payload.completedTurnIndex !== room.activeCommit.turnIndex
        || payload.shotId !== room.activeCommit.shotId) {
        sendError(context, envelope.clientSeq, 'RESULT_NOT_EXPECTED', false, 'Result identity mismatch');
        return;
    }
    if (payload.simulationStatus !== 'OK') {
        if (payload.checkpoint !== null || payload.stateHash !== null
            || typeof payload.errorCode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.errorCode)) {
            sendError(context, envelope.clientSeq, 'SNAPSHOT_INVALID', false, 'Physics failure union invalid');
            return;
        }
        abortRoom(room, 'PHYSICS_FAILURE', payload.errorCode);
        return;
    }
    if (payload.errorCode !== null || !payload.checkpoint || !isHash8(payload.stateHash)) {
        sendError(context, envelope.clientSeq, 'SNAPSHOT_INVALID', false, 'Successful result union invalid');
        return;
    }
    const checkpointErrors = validateCheckpoint(payload.checkpoint);
    if (checkpointErrors.length > 0
        || payload.checkpoint.turnIndex !== payload.completedTurnIndex + 1
        || checkpointHash(payload.checkpoint) !== payload.stateHash) {
        sendError(context, envelope.clientSeq, 'SNAPSHOT_INVALID', false, checkpointErrors.join(',') || 'Hash mismatch');
        return;
    }

    const previous = room.settled.get(context.connectionId);
    if (previous) {
        if (stableJson(previous) !== stableJson(payload)) {
            sendError(context, envelope.clientSeq, 'RESULT_CONFLICT', true, 'Conflicting settled result');
            abortRoom(room, 'PROTOCOL_FATAL', 'RESULT_CONFLICT');
        } else {
            send(context, 'TURN_SETTLED_ACK', {
                matchId: room.matchId,
                completedTurnIndex: payload.completedTurnIndex,
                shotId: payload.shotId,
                acceptedHash: payload.stateHash,
            });
        }
        return;
    }

    room.settled.set(context.connectionId, payload);
    send(context, 'TURN_SETTLED_ACK', {
        matchId: room.matchId,
        completedTurnIndex: payload.completedTurnIndex,
        shotId: payload.shotId,
        acceptedHash: payload.stateHash,
    });
    if (!room.guest || room.settled.size < 2) return;
    clearRoomTimer(room, 'RESULT');

    const hostResult = room.settled.get(room.host.connectionId);
    const guestResult = room.settled.get(room.guest.connectionId);
    if (!hostResult?.checkpoint || !hostResult.stateHash || !guestResult?.stateHash) {
        abortRoom(room, 'PHYSICS_FAILURE', 'Missing valid candidate');
        return;
    }
    const matched = hostResult.stateHash === guestResult.stateHash;
    const nextTurnIndex = payload.completedTurnIndex + 1;
    const resolution: TurnResolutionPayload = {
        roomCode: room.roomCode,
        matchId: room.matchId,
        completedTurnIndex: payload.completedTurnIndex,
        resolutionId: randomUUID(),
        resolutionType: matched ? 'MATCHED' : 'HOST_OVERRIDE',
        authoritativeCheckpoint: cloneCheckpoint(hostResult.checkpoint),
        authoritativeHash: hostResult.stateHash,
        nextTurnIndex,
        nextExpectedCamp: nextTurnIndex < 8 ? expectedCampForTurn(nextTurnIndex) : null,
    };
    room.pendingResolution = { payload: resolution, applied: new Set() };
    room.roomState = 'RESOLVING';
    room.turnPhase = null;
    broadcast(room, matched ? 'TURN_CONFIRMED' : 'STATE_SYNC', resolution);
    scheduleRoomTimer(room, 'APPLY', APPLY_TIMEOUT_MS, () => {
        abortRoom(room, 'APPLY_TIMEOUT', 'Both clients did not apply resolution');
    });
}

function handleResolutionApplied(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (!exactPayload(envelope.payload, ['matchId', 'completedTurnIndex', 'resolutionId', 'appliedHash'])) {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'Resolution ACK payload invalid');
        return;
    }
    const room = requireRoomState(context, envelope.clientSeq, 'RESOLVING');
    if (!room?.pendingResolution) return;
    const payload = envelope.payload as {
        matchId: unknown;
        completedTurnIndex: unknown;
        resolutionId: unknown;
        appliedHash: unknown;
    };
    const resolution = room.pendingResolution.payload;
    if (payload.matchId !== room.matchId
        || payload.completedTurnIndex !== resolution.completedTurnIndex
        || payload.resolutionId !== resolution.resolutionId
        || payload.appliedHash !== resolution.authoritativeHash) {
        sendError(context, envelope.clientSeq, 'HASH_MISMATCH_ON_APPLY', true, 'Applied hash mismatch');
        abortRoom(room, 'PROTOCOL_FATAL', 'HASH_MISMATCH_ON_APPLY');
        return;
    }
    room.pendingResolution.applied.add(context.connectionId);
    if (room.pendingResolution.applied.size < 2) return;
    clearRoomTimer(room, 'APPLY');
    room.confirmedCheckpoint = cloneCheckpoint(resolution.authoritativeCheckpoint);
    room.confirmedStateHash = resolution.authoritativeHash;
    room.turnIndex = resolution.nextTurnIndex;
    room.lastCompletedResolution = resolution;
    room.activeCommit = null;
    room.settled.clear();
    room.pendingResolution = null;

    if (room.turnIndex >= 8) {
        room.roomState = 'FINISHED';
        room.turnPhase = null;
        broadcast(room, 'MATCH_FINISHED', {
            matchId: room.matchId,
            resolutionId: resolution.resolutionId,
            finalCheckpoint: cloneCheckpoint(room.confirmedCheckpoint),
            finalHash: room.confirmedStateHash,
            redScore: room.confirmedCheckpoint.redScore,
            blueScore: room.confirmedCheckpoint.blueScore,
            winnerCode: room.confirmedCheckpoint.winnerCode,
        });
        scheduleRoomTimer(room, 'TTL', FINISHED_TTL_MS, () => deleteRoom(room));
        return;
    }

    room.expectedCamp = expectedCampForTurn(room.turnIndex);
    room.roomState = 'PLAYING';
    room.turnPhase = 'WAITING_SHOT';
    broadcast(room, 'TURN_BEGIN', {
        matchId: room.matchId,
        turnIndex: room.turnIndex,
        expectedCamp: room.expectedCamp,
        confirmedStateHash: room.confirmedStateHash,
    });
}

function handlePing(context: ConnectionContext, envelope: ClientEnvelope): void {
    if (!exactPayload(envelope.payload, ['nonce'])) {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'PING payload invalid');
        return;
    }
    const nonce = (envelope.payload as { nonce: unknown }).nonce;
    if (typeof nonce !== 'string' || nonce.length > 32) {
        sendError(context, envelope.clientSeq, 'MALFORMED_JSON', false, 'PING nonce invalid');
        return;
    }
    send(context, 'PONG', { nonce, serverMonoMs: Math.round(monotonicMs()) });
}

function handleDuplicate(context: ConnectionContext, envelope: ClientEnvelope): void {
    const room = getContextRoom(context);
    if (envelope.type === 'HELLO' && context.helloComplete) {
        send(context, 'HELLO_ACK', { sessionId: context.sessionId });
    } else if (envelope.type === 'JOIN_ROOM' && room) {
        if (room.roomState === 'WAITING') {
            send(context, 'ROOM_WAITING', { roomCode: room.roomCode, localRole: 'HOST', localCamp: 'RED' });
        } else if (context.role && context.camp) {
            sendMatchPrepare(room, context);
        }
    } else if (envelope.type === 'SHOT_INTENT' && room?.activeCommit) {
        send(context, 'SHOT_COMMIT', room.activeCommit);
    } else if (envelope.type === 'TURN_SETTLED' && room?.activeCommit) {
        const stored = room.settled.get(context.connectionId);
        if (stored?.stateHash) {
            send(context, 'TURN_SETTLED_ACK', {
                matchId: room.matchId,
                completedTurnIndex: stored.completedTurnIndex,
                shotId: stored.shotId,
                acceptedHash: stored.stateHash,
            });
        }
    } else if (envelope.type === 'TURN_RESOLUTION_APPLIED' && room?.lastCompletedResolution) {
        resendCurrentProgress(room, context);
    } else if (envelope.type === 'PING') {
        handlePing(context, envelope);
    }
}

function createRoom(roomCode: string, host: ConnectionContext): Room {
    return {
        roomCode,
        roomState: 'WAITING',
        turnPhase: null,
        matchId: '',
        host,
        guest: null,
        turnIndex: 0,
        expectedCamp: 'RED',
        confirmedCheckpoint: cloneCheckpoint(INITIAL_CHECKPOINT),
        confirmedStateHash: RULESET_MANIFEST.initialStateHash,
        activeCommit: null,
        settled: new Map(),
        ready: new Set(),
        pendingResolution: null,
        lastCompletedResolution: null,
        timers: new Map(),
        createdAtServerMono: monotonicMs(),
        lastActivityAtServerMono: monotonicMs(),
    };
}

function sendMatchPrepare(room: Room, context: ConnectionContext): void {
    if (!context.role || !context.camp) return;
    const payload: MatchPreparePayload = {
        roomCode: room.roomCode,
        matchId: room.matchId,
        localRole: context.role,
        localCamp: context.camp,
        rulesetVersion: PVP_RULESET_VERSION,
        initialCheckpoint: cloneCheckpoint(room.confirmedCheckpoint),
        initialStateHash: room.confirmedStateHash,
        readyDeadlineMs: READY_TIMEOUT_MS,
    };
    send(context, 'MATCH_PREPARE', payload);
}

function resendCurrentProgress(room: Room, context: ConnectionContext): void {
    if (room.roomState === 'FINISHED' && room.lastCompletedResolution) {
        send(context, 'MATCH_FINISHED', {
            matchId: room.matchId,
            resolutionId: room.lastCompletedResolution.resolutionId,
            finalCheckpoint: cloneCheckpoint(room.confirmedCheckpoint),
            finalHash: room.confirmedStateHash,
            redScore: room.confirmedCheckpoint.redScore,
            blueScore: room.confirmedCheckpoint.blueScore,
            winnerCode: room.confirmedCheckpoint.winnerCode,
        });
    } else if (room.roomState === 'PLAYING') {
        send(context, 'TURN_BEGIN', {
            matchId: room.matchId,
            turnIndex: room.turnIndex,
            expectedCamp: room.expectedCamp,
            confirmedStateHash: room.confirmedStateHash,
        });
    }
}

function sameIntent(commit: ShotCommitPayload, intent: ShotIntentPayload): boolean {
    const { expectedCamp: _camp, shotId: _shotId, ...base } = commit;
    return stableJson(base) === stableJson(intent);
}

function commandPart(payload: ShotIntentPayload): object {
    return {
        directionXQ: payload.directionXQ,
        directionYQ: payload.directionYQ,
        pullRatioQ: payload.pullRatioQ,
        curveRatioQ: payload.curveRatioQ,
    };
}

function attach(context: ConnectionContext, roomCode: string, role: PvpRole, camp: PvpCamp): void {
    context.roomCode = roomCode;
    context.role = role;
    context.camp = camp;
}

function detach(context: ConnectionContext): void {
    context.roomCode = '';
    context.role = null;
    context.camp = null;
}

function disconnect(context: ConnectionContext, reason: string): void {
    connections.delete(context.connectionId);
    const room = getContextRoom(context);
    if (!room) return;
    if (room.roomState === 'FINISHED' || room.roomState === 'ABORTED') {
        broadcast(room, 'ROOM_LEFT', {
            roomCode: room.roomCode,
            matchId: room.matchId || null,
            reason,
        });
        deleteRoom(room);
    } else if (room.roomState === 'WAITING' && room.host === context) deleteRoom(room);
    else {
        abortRoom(room, reason, 'WebSocket disconnected');
    }
    detach(context);
}

function abortConnectionRoom(context: ConnectionContext, reasonCode: string, detail: string): void {
    const room = getContextRoom(context);
    if (room) abortRoom(room, reasonCode, detail);
}

function abortRoom(room: Room, reasonCode: string, detail: string): void {
    if (room.roomState === 'ABORTED' || room.roomState === 'FINISHED') return;
    clearAllRoomTimers(room);
    room.roomState = 'ABORTED';
    room.turnPhase = null;
    broadcast(room, 'MATCH_ABORTED', {
        matchId: room.matchId || null,
        reasonCode,
        detail: detail.slice(0, 256),
    });
    scheduleRoomTimer(room, 'TTL', CLOSED_ABORT_TTL_MS, () => deleteRoom(room));
}

function deleteRoom(room: Room): void {
    clearAllRoomTimers(room);
    rooms.delete(room.roomCode);
    if (room.host.roomCode === room.roomCode) detach(room.host);
    if (room.guest?.roomCode === room.roomCode) detach(room.guest);
}

function requireRoomState(
    context: ConnectionContext,
    requestClientSeq: number,
    state: RoomState,
): Room | null {
    const room = getContextRoom(context);
    if (!room) {
        sendError(context, requestClientSeq, 'NOT_ROOM_MEMBER', false, 'Not in a room');
        return null;
    }
    if (room.roomState !== state) {
        sendError(context, requestClientSeq, 'INVALID_STATE', false, `${room.roomState} != ${state}`);
        return null;
    }
    return room;
}

function getContextRoom(context: ConnectionContext): Room | null {
    return context.roomCode ? rooms.get(context.roomCode) ?? null : null;
}

function scheduleRoomTimer(room: Room, name: TimerName, delayMs: number, action: () => void): void {
    clearRoomTimer(room, name);
    const timer = setTimeout(() => {
        room.timers.delete(name);
        action();
    }, delayMs);
    room.timers.set(name, timer);
}

function clearRoomTimer(room: Room, name: TimerName): void {
    const timer = room.timers.get(name);
    if (timer) clearTimeout(timer);
    room.timers.delete(name);
}

function clearAllRoomTimers(room: Room): void {
    for (const timer of room.timers.values()) clearTimeout(timer);
    room.timers.clear();
}

function broadcast(room: Room, type: string, payload: unknown): void {
    send(room.host, type, payload);
    if (room.guest) send(room.guest, type, payload);
}

function send(context: ConnectionContext, type: string, payload: unknown): void {
    if (context.socket.readyState !== WebSocket.OPEN) return;
    const envelope: ServerEnvelope = {
        type,
        protocolVersion: PVP_PROTOCOL_VERSION,
        serverSeq: ++context.serverSeq,
        payload,
    };
    const text = JSON.stringify(envelope);
    const now = Date.now();
    const scheduledAt = Math.max(now + context.simulatedLatencyMs, context.lastScheduledSendAt + 1);
    context.lastScheduledSendAt = scheduledAt;
    setTimeout(() => {
        if (context.socket.readyState === WebSocket.OPEN) context.socket.send(text);
    }, Math.max(0, scheduledAt - now));
}

function sendError(
    context: ConnectionContext,
    requestClientSeq: number | null,
    code: string,
    fatal: boolean,
    detail: string,
): void {
    send(context, 'ERROR', {
        requestClientSeq,
        code,
        fatal,
        detail: detail.slice(0, 256),
    });
}

function isClientEnvelope(value: unknown): value is ClientEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'clientSeq', 'payload'])) return false;
    const envelope = value as ClientEnvelope;
    return typeof envelope.type === 'string'
        && envelope.type.length >= 1
        && envelope.type.length <= 64
        && isSafeInteger(envelope.clientSeq)
        && envelope.clientSeq > 0
        && !!envelope.payload
        && typeof envelope.payload === 'object'
        && !Array.isArray(envelope.payload);
}

function exactPayload(value: unknown, keys: string[]): boolean {
    return !!value && typeof value === 'object' && !Array.isArray(value) && hasExactKeys(value, keys);
}

function jsonDepth(value: unknown, depth = 0): number {
    if (!value || typeof value !== 'object') return depth;
    if (depth > 6) return depth;
    const children = Array.isArray(value) ? value : Object.values(value as object);
    return children.reduce((maximum, child) => Math.max(maximum, jsonDepth(child, depth + 1)), depth);
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function monotonicMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
}
