import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
    checkpointHash,
    cloneCheckpoint,
    deriveCheckpointScores,
    deriveWinnerCode,
    validateCheckpoint,
} from '../../assets/scripts/shared/CheckpointCodec';
import {
    INITIAL_CHECKPOINT,
    PVP_PROTOCOL_VERSION,
    PVP_RULESET_VERSION,
} from '../../assets/scripts/shared/RulesetManifest';
import { ClientEnvelope, ServerEnvelope } from '../../assets/scripts/shared/PvpProtocol';
import { CheckpointV1 } from '../../assets/scripts/shared/PvpTypes';

interface MatchSession {
    host: TestClient;
    guest: TestClient;
    roomCode: string;
    matchId: string;
    hostSessionId: string;
    guestSessionId: string;
}

class TestClient {
    private readonly socket: WebSocket;
    private clientSeq = 0;
    private readonly inbox: ServerEnvelope[] = [];
    private readonly listeners: Array<() => void> = [];

    public constructor(url: string) {
        this.socket = new WebSocket(url);
        this.socket.on('message', raw => {
            this.inbox.push(JSON.parse(raw.toString()) as ServerEnvelope);
            for (const listener of this.listeners.splice(0)) listener();
        });
    }

    public async open(): Promise<void> {
        if (this.socket.readyState === WebSocket.OPEN) return;
        await new Promise<void>((resolve, reject) => {
            this.socket.once('open', resolve);
            this.socket.once('error', reject);
        });
    }

    public send(type: string, payload: unknown): ClientEnvelope {
        const envelope: ClientEnvelope = {
            type,
            protocolVersion: PVP_PROTOCOL_VERSION,
            clientSeq: ++this.clientSeq,
            payload,
        };
        this.socket.send(JSON.stringify(envelope));
        return envelope;
    }

    public resend(envelope: ClientEnvelope): void {
        this.socket.send(JSON.stringify(envelope));
    }

    public async wait(type: string, timeoutMs = 8_000): Promise<ServerEnvelope> {
        return this.waitWhere(message => message.type === type, type, timeoutMs);
    }

    public async waitError(code: string, timeoutMs = 8_000): Promise<ServerEnvelope> {
        return this.waitWhere(
            message => message.type === 'ERROR' && (message.payload as { code?: string }).code === code,
            `ERROR(${code})`,
            timeoutMs,
            false,
        );
    }

    public async expectNo(type: string, timeoutMs = 250): Promise<void> {
        try {
            await this.waitWhere(message => message.type === type, type, timeoutMs, false);
        } catch (error) {
            if (String(error).indexOf(`Timeout waiting for ${type}`) >= 0) return;
            throw error;
        }
        throw new Error(`Unexpected extra ${type}`);
    }

    public async close(): Promise<void> {
        if (this.socket.readyState === WebSocket.CLOSED) return;
        await new Promise<void>(resolve => {
            this.socket.once('close', () => resolve());
            this.socket.close();
        });
    }

    private async waitWhere(
        predicate: (message: ServerEnvelope) => boolean,
        label: string,
        timeoutMs: number,
        failOnUnexpectedError = true,
    ): Promise<ServerEnvelope> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const index = this.inbox.findIndex(predicate);
            if (index >= 0) return this.inbox.splice(index, 1)[0];
            if (failOnUnexpectedError) {
                const errorIndex = this.inbox.findIndex(message => message.type === 'ERROR');
                if (errorIndex >= 0) {
                    const error = this.inbox.splice(errorIndex, 1)[0];
                    throw new Error(`Unexpected ERROR: ${JSON.stringify(error.payload)}`);
                }
            }
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(`Timeout waiting for ${label}`)),
                    Math.max(1, deadline - Date.now()),
                );
                this.listeners.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        throw new Error(`Timeout waiting for ${label}`);
    }
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function hello(client: TestClient, clientInstanceId = randomUUID()): Promise<string> {
    await client.open();
    client.send('HELLO', { clientInstanceId, rulesetVersion: PVP_RULESET_VERSION });
    const ack = await client.wait('HELLO_ACK');
    return (ack.payload as { sessionId: string }).sessionId;
}

async function setupMatch(roomCode: string, latencyMs: number): Promise<MatchSession> {
    const host = new TestClient(`ws://127.0.0.1:8081?latency=${latencyMs}`);
    const guest = new TestClient(`ws://127.0.0.1:8081?latency=${latencyMs}`);
    const [hostSessionId, guestSessionId] = await Promise.all([hello(host), hello(guest)]);
    assert(hostSessionId !== guestSessionId, 'session ids must differ');

    host.send('JOIN_ROOM', { roomCode });
    const waiting = await host.wait('ROOM_WAITING');
    assert((waiting.payload as { localRole: string; localCamp: string }).localRole === 'HOST', 'host role');
    assert((waiting.payload as { localCamp: string }).localCamp === 'RED', 'host camp');

    guest.send('JOIN_ROOM', { roomCode });
    const [hostPrepare, guestPrepare] = await Promise.all([
        host.wait('MATCH_PREPARE'),
        guest.wait('MATCH_PREPARE'),
    ]);
    const hostData = hostPrepare.payload as { matchId: string; initialStateHash: string };
    const guestData = guestPrepare.payload as { matchId: string; localRole: string; localCamp: string };
    assert(guestData.localRole === 'GUEST' && guestData.localCamp === 'BLUE', 'guest identity');
    assert(hostData.matchId === guestData.matchId, 'same match id');
    assert(hostData.initialStateHash === checkpointHash(INITIAL_CHECKPOINT), 'initial hash');

    host.send('MATCH_READY', { matchId: hostData.matchId, observedInitialHash: hostData.initialStateHash });
    guest.send('MATCH_READY', { matchId: hostData.matchId, observedInitialHash: hostData.initialStateHash });
    const [hostBegin, guestBegin] = await Promise.all([host.wait('TURN_BEGIN'), guest.wait('TURN_BEGIN')]);
    assert((hostBegin.payload as { expectedCamp: string }).expectedCamp === 'RED', 'red starts');
    assert((guestBegin.payload as { turnIndex: number }).turnIndex === 0, 'guest starts at turn 0');
    return { host, guest, roomCode, matchId: hostData.matchId, hostSessionId, guestSessionId };
}

function checkpointAfterTurn(completedTurnIndex: number): CheckpointV1 {
    const nextTurn = completedTurnIndex + 1;
    const discs = Array.from({ length: 8 }, (_, idCode) => {
        if (idCode < nextTurn) return { idCode, stateCode: 2 as const, xQ: idCode * 2_000, yQ: 0 };
        if (idCode === nextTurn && nextTurn < 8) {
            return { idCode, stateCode: 1 as const, xQ: 0, yQ: -740_000 };
        }
        return { idCode, stateCode: 0 as const, xQ: 0, yQ: 0 };
    });
    const scores = deriveCheckpointScores(discs);
    const checkpoint: CheckpointV1 = {
        schemaVersion: 1,
        phaseCode: nextTurn >= 8 ? 1 : 0,
        turnIndex: nextTurn,
        redScore: scores.redScore,
        blueScore: scores.blueScore,
        winnerCode: deriveWinnerCode(scores.redScore, scores.blueScore, nextTurn >= 8),
        discs,
    };
    const errors = validateCheckpoint(checkpoint);
    assert(errors.length === 0, `generated checkpoint invalid: ${errors.join(',')}`);
    return checkpoint;
}

async function playEightTurns(session: MatchSession, desyncTurns: number[] = []): Promise<object[]> {
    let confirmedHash = checkpointHash(INITIAL_CHECKPOINT);
    const evidence: object[] = [];
    for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) {
        const shooter = turnIndex % 2 === 0 ? session.host : session.guest;
        const wrongSide = turnIndex % 2 === 0 ? session.guest : session.host;
        if (turnIndex === 0) {
            wrongSide.send('SHOT_INTENT', {
                roomCode: session.roomCode,
                matchId: session.matchId,
                turnIndex,
                intentId: randomUUID(),
                preStateHash: confirmedHash,
                directionXQ: 0,
                directionYQ: 1_000_000,
                pullRatioQ: 5_000,
                curveRatioQ: 0,
            });
            await wrongSide.waitError('NOT_YOUR_TURN');
        }

        const intent = {
            roomCode: session.roomCode,
            matchId: session.matchId,
            turnIndex,
            intentId: randomUUID(),
            preStateHash: confirmedHash,
            directionXQ: 0,
            directionYQ: 1_000_000,
            pullRatioQ: 5_000 + turnIndex * 100,
            curveRatioQ: turnIndex % 2 === 0 ? 2_000 : -2_000,
        };
        shooter.send('SHOT_INTENT', intent);
        const [hostCommit, guestCommit] = await Promise.all([
            session.host.wait('SHOT_COMMIT'),
            session.guest.wait('SHOT_COMMIT'),
        ]);
        const shotId = (hostCommit.payload as { shotId: string }).shotId;
        assert((guestCommit.payload as { shotId: string }).shotId === shotId, `turn ${turnIndex} shot id`);

        if (turnIndex === 0) {
            shooter.send('SHOT_INTENT', intent);
            const duplicateCommit = await shooter.wait('SHOT_COMMIT');
            assert((duplicateCommit.payload as { shotId: string }).shotId === shotId, 'duplicate intent reuses shot');
        }

        const hostCheckpoint = checkpointAfterTurn(turnIndex);
        const guestCheckpoint = cloneCheckpoint(hostCheckpoint);
        const injectDesync = desyncTurns.indexOf(turnIndex) >= 0;
        if (injectDesync) guestCheckpoint.discs[0].xQ += 1_000;
        const hostHash = checkpointHash(hostCheckpoint);
        const guestHash = checkpointHash(guestCheckpoint);
        const baseResult = {
            roomCode: session.roomCode,
            matchId: session.matchId,
            completedTurnIndex: turnIndex,
            shotId,
            simulationStatus: 'OK',
            errorCode: null,
        };
        const hostEnvelope = session.host.send('TURN_SETTLED', {
            ...baseResult,
            stateHash: hostHash,
            checkpoint: hostCheckpoint,
        });
        session.guest.send('TURN_SETTLED', {
            ...baseResult,
            stateHash: guestHash,
            checkpoint: guestCheckpoint,
        });
        const resolutionType = injectDesync ? 'STATE_SYNC' : 'TURN_CONFIRMED';
        const [hostAck, guestAck, hostResolution, guestResolution] = await Promise.all([
            session.host.wait('TURN_SETTLED_ACK'),
            session.guest.wait('TURN_SETTLED_ACK'),
            session.host.wait(resolutionType),
            session.guest.wait(resolutionType),
        ]);
        assert((hostAck.payload as { acceptedHash: string }).acceptedHash === hostHash, 'host ack hash');
        assert((guestAck.payload as { acceptedHash: string }).acceptedHash === guestHash, 'guest ack hash');
        const hostResolutionData = hostResolution.payload as {
            resolutionId: string;
            authoritativeHash: string;
            resolutionType: string;
        };
        const guestResolutionData = guestResolution.payload as { resolutionId: string };
        assert(hostResolutionData.resolutionId === guestResolutionData.resolutionId, 'same resolution id');
        assert(hostResolutionData.authoritativeHash === hostHash, 'host is authoritative');
        assert(hostResolutionData.resolutionType === (injectDesync ? 'HOST_OVERRIDE' : 'MATCHED'), 'resolution type');

        if (turnIndex === 0) {
            session.host.resend(hostEnvelope);
            const duplicateAck = await session.host.wait('TURN_SETTLED_ACK');
            assert((duplicateAck.payload as { acceptedHash: string }).acceptedHash === hostHash, 'duplicate settled ack');
        }

        const applied = {
            matchId: session.matchId,
            completedTurnIndex: turnIndex,
            resolutionId: hostResolutionData.resolutionId,
            appliedHash: hostHash,
        };
        session.host.send('TURN_RESOLUTION_APPLIED', applied);
        session.guest.send('TURN_RESOLUTION_APPLIED', applied);
        evidence.push({
            turnIndex,
            intentId: intent.intentId,
            shotId,
            hostHash,
            guestHash,
            authoritativeHash: hostResolutionData.authoritativeHash,
            resolutionType: hostResolutionData.resolutionType,
        });
        confirmedHash = hostHash;

        if (turnIndex < 7) {
            const [hostNext, guestNext] = await Promise.all([
                session.host.wait('TURN_BEGIN'),
                session.guest.wait('TURN_BEGIN'),
            ]);
            assert((hostNext.payload as { turnIndex: number }).turnIndex === turnIndex + 1, 'next host turn');
            assert((guestNext.payload as { confirmedStateHash: string }).confirmedStateHash === confirmedHash, 'next guest hash');
        } else {
            const [hostFinished, guestFinished] = await Promise.all([
                session.host.wait('MATCH_FINISHED'),
                session.guest.wait('MATCH_FINISHED'),
            ]);
            assert(JSON.stringify(hostFinished.payload) === JSON.stringify(guestFinished.payload), 'identical match result');
            assert((hostFinished.payload as { finalHash: string }).finalHash === confirmedHash, 'final hash');
            await Promise.all([
                session.host.expectNo('MATCH_FINISHED'),
                session.guest.expectNo('MATCH_FINISHED'),
            ]);
        }
    }
    return evidence;
}

async function roomFullTest(roomCode: string): Promise<void> {
    const session = await setupMatch(roomCode, 0);
    const third = new TestClient('ws://127.0.0.1:8081?latency=0');
    await hello(third);
    third.send('JOIN_ROOM', { roomCode: session.roomCode });
    await third.waitError('ROOM_FULL');
    await Promise.all([session.host.close(), session.guest.close(), third.close()]);
}

async function waitingCleanupTest(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        const client = new TestClient('ws://127.0.0.1:8081?latency=0');
        await hello(client);
        const roomCode = String(920000 + index).padStart(6, '0');
        client.send('JOIN_ROOM', { roomCode });
        await client.wait('ROOM_WAITING');
        client.send('LEAVE_ROOM', { reason: 'USER' });
        await client.wait('ROOM_LEFT');
        await client.close();
    }
}

async function diagnostics(): Promise<{ activeConnectionCount: number; activeRoomCount: number; activeDeadlineTimerCount: number }> {
    const response = await fetch('http://127.0.0.1:8081/diagnostics');
    return response.json() as Promise<{ activeConnectionCount: number; activeRoomCount: number; activeDeadlineTimerCount: number }>;
}

async function reuseFinishedRoomAfterLeave(session: MatchSession): Promise<void> {
    session.host.send('LEAVE_ROOM', { reason: 'USER' });
    await Promise.all([
        session.host.wait('ROOM_LEFT'),
        session.guest.wait('ROOM_LEFT'),
    ]);
    await Promise.all([session.host.close(), session.guest.close()]);

    const replay = await setupMatch(session.roomCode, 0);
    replay.host.send('LEAVE_ROOM', { reason: 'USER' });
    await Promise.all([
        replay.host.wait('ROOM_LEFT'),
        replay.guest.wait('MATCH_ABORTED'),
    ]);
    await Promise.all([replay.host.close(), replay.guest.close()]);
}

async function reuseFinishedRoomAfterDisconnect(roomCode: string): Promise<void> {
    const session = await setupMatch(roomCode, 0);
    await playEightTurns(session, []);
    await session.host.close();
    await session.guest.wait('ROOM_LEFT');
    await session.guest.close();

    const replay = await setupMatch(roomCode, 0);
    replay.host.send('LEAVE_ROOM', { reason: 'USER' });
    await Promise.all([
        replay.host.wait('ROOM_LEFT'),
        replay.guest.wait('MATCH_ABORTED'),
    ]);
    await Promise.all([replay.host.close(), replay.guest.close()]);
}

async function main(): Promise<void> {
    const roomBase = 200_000 + ((Date.now() + process.pid) % 700_000);
    const matchRoomCode = String(roomBase).padStart(6, '0');
    const fullRoomCode = String(roomBase + 1).padStart(6, '0');
    const disconnectRoomCode = String(roomBase + 2).padStart(6, '0');
    const session = await setupMatch(matchRoomCode, 0);
    const evidence = await playEightTurns(session, [2, 7]);
    await reuseFinishedRoomAfterLeave(session);
    await reuseFinishedRoomAfterDisconnect(disconnectRoomCode);
    await roomFullTest(fullRoomCode);
    await waitingCleanupTest(20);
    await new Promise(resolve => setTimeout(resolve, 300));
    const resources = await diagnostics();
    assert(resources.activeConnectionCount === 0, `connections leaked: ${resources.activeConnectionCount}`);
    assert(resources.activeDeadlineTimerCount <= resources.activeRoomCount, 'unexpected timer leak');

    console.log(JSON.stringify({
        status: 'PASS',
        protocolVersion: PVP_PROTOCOL_VERSION,
        rulesetVersion: PVP_RULESET_VERSION,
        matchId: session.matchId,
        hostSessionId: session.hostSessionId,
        guestSessionId: session.guestSessionId,
        turns: evidence,
        resources,
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
