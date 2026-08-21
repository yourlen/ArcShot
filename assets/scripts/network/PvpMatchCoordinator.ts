import {
    checkpointHash,
    cloneCheckpoint,
    deriveCheckpointScores,
    deriveWinnerCode,
} from '../shared/CheckpointCodec';
import {
    PvpDebugSnapshot,
    RoomState,
    ServerEnvelope,
    ShotCommitPayload,
    TurnPhase,
    TurnResolutionPayload,
    expectedCampForTurn,
    isRoomCode,
} from '../shared/PvpProtocol';
import { PVP_RULESET_VERSION, RULESET_MANIFEST } from '../shared/RulesetManifest';
import { dequantizeShotCommand, quantizeShotCommand } from '../shared/ShotCommandCodec';
import { CheckpointV1, PvpCamp, PvpRole, ShotCommand } from '../shared/PvpTypes';
import { SocketState, WebSocketTransport } from './WebSocketTransport';

export interface PvpGameBridge {
    applyNetworkShot(command: ShotCommand): boolean;
    getNetworkCandidate(): CheckpointV1 | null;
    loadNetworkCheckpoint(checkpoint: CheckpointV1): string;
    getSimulationError(): string | null;
    returnToLobby(): void;
}

export class PvpMatchCoordinator {
    public readonly debug: PvpDebugSnapshot;
    public statusText = '输入6位房间号开始匹配';
    public canLocalInput = false;
    public inRoom = false;
    public lobbyVisible = true;

    private readonly transport = new WebSocketTransport();
    private activeShotId = '';
    private submittedShotId = '';
    private appliedResolutionIds = new Set<string>();
    private lastLoadedHash = '';
    private pingStartedAt = new Map<string, number>();
    private duplicateNextCommit = false;
    private desyncGuestNextResult = false;

    public constructor(private readonly bridge: PvpGameBridge) {
        this.debug = {
            clientInstanceId: createUuid(),
            sessionId: '',
            roomCode: '',
            matchId: '',
            role: '',
            camp: '',
            socketState: 'CLOSED',
            roomState: '',
            turnPhase: null,
            turnIndex: 0,
            expectedCamp: '',
            clientSeq: 0,
            serverSeq: 0,
            intentId: '',
            shotId: '',
            resolutionId: '',
            confirmedStateHash: '',
            candidateStateHash: '',
            remoteStateHash: '',
            hashMatch: '',
            desyncCorrectionCount: 0,
            pingMs: 0,
            simulatedLatencyMs: 0,
            lastError: '',
        };
        this.transport.onMessage = message => this.handleMessage(message);
        this.transport.onStateChange = (state, detail) => this.handleSocketState(state, detail);
        this.transport.onPingSent = nonce => this.pingStartedAt.set(nonce, nowMs());
    }

    public connectAndJoin(roomCodeInput: string, simulatedLatencyMs = 0): boolean {
        const roomCode = roomCodeInput.trim();
        if (!isRoomCode(roomCode)) {
            this.fail('房间号必须是6位数字');
            return false;
        }
        // Lobby is authoritative locally. If an old socket is still finishing its
        // close handshake, discard it before starting the next room session.
        if (this.transport.state !== 'CLOSED') this.transport.close();
        this.pingStartedAt.clear();
        this.debug.clientSeq = 0;
        this.debug.serverSeq = 0;
        this.debug.pingMs = 0;
        this.debug.lastError = '';
        this.debug.roomCode = roomCode;
        this.debug.simulatedLatencyMs = [0, 100, 300, 500].indexOf(simulatedLatencyMs) >= 0
            ? simulatedLatencyMs
            : 0;
        this.statusText = '正在连接本机中继…';
        this.transport.connect(`ws://127.0.0.1:8081?latency=${this.debug.simulatedLatencyMs}`);
        return true;
    }

    public submitLocalShot(command: ShotCommand): boolean {
        if (!this.canLocalInput || !this.inRoom || !this.debug.matchId) return false;
        const quantized = quantizeShotCommand(command);
        const intentId = createUuid();
        this.debug.intentId = intentId;
        this.canLocalInput = false;
        this.statusText = '发射已提交，等待双方确认';
        this.send('SHOT_INTENT', {
            roomCode: this.debug.roomCode,
            matchId: this.debug.matchId,
            turnIndex: this.debug.turnIndex,
            intentId,
            preStateHash: this.debug.confirmedStateHash,
            ...quantized,
        });
        return true;
    }

    public toggleDuplicateNextCommit(): boolean {
        this.duplicateNextCommit = !this.duplicateNextCommit;
        return this.duplicateNextCommit;
    }

    public toggleGuestDesyncNextResult(): boolean {
        this.desyncGuestNextResult = !this.desyncGuestNextResult;
        return this.desyncGuestNextResult;
    }

    public get duplicateCommitArmed(): boolean {
        return this.duplicateNextCommit;
    }

    public get guestDesyncArmed(): boolean {
        return this.desyncGuestNextResult;
    }

    public pollSimulation(): void {
        if (!this.activeShotId || this.submittedShotId === this.activeShotId) return;
        const failure = this.bridge.getSimulationError();
        if (failure) {
            this.submittedShotId = this.activeShotId;
            this.send('TURN_SETTLED', {
                roomCode: this.debug.roomCode,
                matchId: this.debug.matchId,
                completedTurnIndex: this.debug.turnIndex,
                shotId: this.activeShotId,
                stateHash: null,
                checkpoint: null,
                simulationStatus: normalizeSimulationError(failure),
                errorCode: normalizeErrorCode(failure),
            });
            return;
        }
        const sourceCandidate = this.bridge.getNetworkCandidate();
        if (!sourceCandidate) return;
        const candidate = cloneCheckpoint(sourceCandidate);
        if (this.desyncGuestNextResult && this.debug.role === 'GUEST') {
            // Keep the injected checkpoint structurally valid so the relay reaches
            // the hash-divergence/STATE_SYNC path. An OUT or UNPLAYED disc must
            // remain at (0, 0), so prefer a disc that actually stopped on-table.
            const stoppedDisc = candidate.discs.find(disc => disc.stateCode === 2);
            if (stoppedDisc) {
                stoppedDisc.xQ += stoppedDisc.xQ + 1_000 <= RULESET_MANIFEST.rightBoundaryQ
                    ? 1_000
                    : -1_000;
            } else {
                // A shot can leave every played disc OUT. Turn one such past disc
                // into a legal, zero-score stopped disc near the launch line.
                const outDisc = candidate.discs.find(disc => disc.stateCode === 3);
                if (outDisc) {
                    outDisc.stateCode = 2;
                    outDisc.xQ = RULESET_MANIFEST.leftBoundaryQ;
                    outDisc.yQ = RULESET_MANIFEST.launchLineYQ;
                }
            }
            const injectedScores = deriveCheckpointScores(candidate.discs, RULESET_MANIFEST);
            candidate.redScore = injectedScores.redScore;
            candidate.blueScore = injectedScores.blueScore;
            candidate.winnerCode = deriveWinnerCode(
                injectedScores.redScore,
                injectedScores.blueScore,
                candidate.turnIndex === 8,
            );
            this.desyncGuestNextResult = false;
        }
        const stateHash = checkpointHash(candidate);
        this.debug.candidateStateHash = stateHash;
        this.submittedShotId = this.activeShotId;
        this.statusText = '本地已停稳，等待对方结果';
        this.send('TURN_SETTLED', {
            roomCode: this.debug.roomCode,
            matchId: this.debug.matchId,
            completedTurnIndex: this.debug.turnIndex,
            shotId: this.activeShotId,
            stateHash,
            checkpoint: candidate,
            simulationStatus: 'OK',
            errorCode: null,
        });
    }

    public leave(reason: 'USER' | 'PAGE_HIDDEN'): void {
        if (this.inRoom && this.transport.state === 'OPEN') {
            try {
                this.send('LEAVE_ROOM', { reason });
            } catch {
                // Disconnect cleanup on the relay releases the room as a fallback.
            }
        }
        if (reason === 'USER') {
            // Do not make the visible lobby transition depend on a terminal ACK.
            // WebSocket close still releases a FINISHED room if LEAVE_ROOM was lost.
            this.resetToLobbyState('已离开对局');
        } else {
            this.canLocalInput = false;
            this.statusText = '页面隐藏，对局已终止';
        }
        this.transport.close();
    }

    public dispose(): void {
        this.transport.close();
    }

    public debugText(): string {
        const d = this.debug;
        return [
            `Client ${short(d.clientInstanceId)}  Session ${short(d.sessionId)}`,
            `Room ${d.roomCode || '--'}  Match ${short(d.matchId)}  ${d.role || '--'}/${d.camp || '--'}`,
            `Socket ${d.socketState}  ${d.roomState || '--'}/${d.turnPhase || '--'}`,
            `Turn ${d.turnIndex}  Expected ${d.expectedCamp || '--'}  Seq ${d.clientSeq}/${d.serverSeq}`,
            `Intent ${short(d.intentId)}  Shot ${short(d.shotId)}  Resolution ${short(d.resolutionId)}`,
            `Hash C=${d.confirmedStateHash || '--'} L=${d.candidateStateHash || '--'} R=${d.remoteStateHash || '--'}`,
            `Match ${d.hashMatch || '--'}  Corrections ${d.desyncCorrectionCount}  Ping ${d.pingMs.toFixed(0)}ms  Delay ${d.simulatedLatencyMs}ms`,
            `Inject DupCommit=${this.duplicateNextCommit ? 'ON' : 'OFF'} GuestDesync=${this.desyncGuestNextResult ? 'ON' : 'OFF'}`,
            `Error ${d.lastError || '--'}`,
        ].join('\n');
    }

    private handleSocketState(state: SocketState, detail: string): void {
        this.debug.socketState = state;
        if (state === 'OPEN') {
            this.statusText = '已连接，正在验证版本';
            this.send('HELLO', {
                clientInstanceId: this.debug.clientInstanceId,
                rulesetVersion: PVP_RULESET_VERSION,
            });
        } else if (state === 'ERROR') {
            this.fail(detail);
        } else if (state === 'CLOSED' && this.inRoom) {
            this.canLocalInput = false;
            this.statusText = '连接已关闭，本局终止';
        }
    }

    private handleMessage(message: ServerEnvelope): void {
        this.debug.serverSeq = message.serverSeq;
        switch (message.type) {
            case 'HELLO_ACK': this.onHelloAck(message.payload); break;
            case 'ROOM_WAITING': this.onRoomWaiting(message.payload); break;
            case 'MATCH_PREPARE': this.onMatchPrepare(message.payload); break;
            case 'TURN_BEGIN': this.onTurnBegin(message.payload); break;
            case 'SHOT_COMMIT': this.onShotCommit(message.payload); break;
            case 'TURN_SETTLED_ACK': this.statusText = '结果已接收，等待回合裁决'; break;
            case 'TURN_CONFIRMED': this.onResolution(message.payload, false); break;
            case 'STATE_SYNC': this.onResolution(message.payload, true); break;
            case 'MATCH_FINISHED': this.onMatchFinished(message.payload); break;
            case 'MATCH_ABORTED': this.onMatchAborted(message.payload); break;
            case 'ROOM_LEFT': this.onRoomLeft(); break;
            case 'PONG': this.onPong(message.payload); break;
            case 'ERROR': this.onError(message.payload); break;
        }
    }

    private onHelloAck(payload: unknown): void {
        const data = payload as { sessionId: string };
        this.debug.sessionId = data.sessionId;
        this.send('JOIN_ROOM', { roomCode: this.debug.roomCode });
        this.statusText = '正在进入房间';
    }

    private onRoomWaiting(payload: unknown): void {
        const data = payload as { localRole: PvpRole; localCamp: PvpCamp };
        this.debug.role = data.localRole;
        this.debug.camp = data.localCamp;
        this.debug.roomState = 'WAITING';
        this.inRoom = true;
        this.lobbyVisible = false;
        this.statusText = `房间 ${this.debug.roomCode}：等待蓝方加入`;
    }

    private onMatchPrepare(payload: unknown): void {
        const data = payload as {
            roomCode: string;
            matchId: string;
            localRole: PvpRole;
            localCamp: PvpCamp;
            initialCheckpoint: CheckpointV1;
            initialStateHash: string;
        };
        this.debug.roomCode = data.roomCode;
        this.debug.matchId = data.matchId;
        this.debug.role = data.localRole;
        this.debug.camp = data.localCamp;
        this.debug.roomState = 'STARTING';
        this.inRoom = true;
        this.lobbyVisible = false;
        this.appliedResolutionIds.clear();
        this.activeShotId = '';
        this.submittedShotId = '';
        const observed = this.bridge.loadNetworkCheckpoint(data.initialCheckpoint);
        this.lastLoadedHash = observed;
        this.debug.confirmedStateHash = data.initialStateHash;
        this.send('MATCH_READY', { matchId: data.matchId, observedInitialHash: observed });
        this.statusText = '双方已加入，正在确认初始状态';
    }

    private onTurnBegin(payload: unknown): void {
        const data = payload as {
            matchId: string;
            turnIndex: number;
            expectedCamp: PvpCamp;
            confirmedStateHash: string;
        };
        if (data.matchId !== this.debug.matchId || this.lastLoadedHash !== data.confirmedStateHash) {
            this.fail('TURN_BEGIN_HASH_MISMATCH');
            this.leave('USER');
            return;
        }
        this.debug.roomState = 'PLAYING';
        this.debug.turnPhase = 'WAITING_SHOT';
        this.debug.turnIndex = data.turnIndex;
        this.debug.expectedCamp = data.expectedCamp;
        this.debug.confirmedStateHash = data.confirmedStateHash;
        this.debug.candidateStateHash = '';
        this.debug.remoteStateHash = '';
        this.activeShotId = '';
        this.submittedShotId = '';
        this.canLocalInput = data.expectedCamp === this.debug.camp;
        this.statusText = this.canLocalInput
            ? `第${data.turnIndex + 1}回合：轮到你发射`
            : `第${data.turnIndex + 1}回合：等待对方发射`;
    }

    private onShotCommit(payload: unknown): void {
        const commit = payload as ShotCommitPayload;
        if (commit.matchId !== this.debug.matchId || commit.turnIndex !== this.debug.turnIndex) {
            this.fail('SHOT_COMMIT_IDENTITY_MISMATCH');
            return;
        }
        if (this.activeShotId === commit.shotId) return;
        const command = dequantizeShotCommand({
            directionXQ: commit.directionXQ,
            directionYQ: commit.directionYQ,
            pullRatioQ: commit.pullRatioQ,
            curveRatioQ: commit.curveRatioQ,
        });
        if (!this.bridge.applyNetworkShot(command)) {
            this.fail('APPLY_COMMITTED_SHOT_FAILED');
            return;
        }
        this.activeShotId = commit.shotId;
        this.debug.shotId = commit.shotId;
        this.debug.turnPhase = 'WAITING_RESULTS';
        this.canLocalInput = false;
        this.statusText = `${commit.expectedCamp === 'RED' ? '红方' : '蓝方'}圆盘运动中`;
        if (this.duplicateNextCommit) {
            this.duplicateNextCommit = false;
            this.onShotCommit(commit);
        }
    }

    private onResolution(payload: unknown, corrected: boolean): void {
        const resolution = payload as TurnResolutionPayload;
        if (resolution.matchId !== this.debug.matchId) {
            this.fail('RESOLUTION_MATCH_MISMATCH');
            return;
        }
        this.debug.roomState = 'RESOLVING';
        this.debug.turnPhase = null;
        this.debug.resolutionId = resolution.resolutionId;
        this.debug.remoteStateHash = resolution.authoritativeHash;
        this.debug.hashMatch = corrected ? 'NO' : 'YES';
        if (corrected) this.debug.desyncCorrectionCount += 1;
        let appliedHash: string;
        if (this.appliedResolutionIds.has(resolution.resolutionId)) {
            appliedHash = this.lastLoadedHash;
        } else {
            appliedHash = this.bridge.loadNetworkCheckpoint(resolution.authoritativeCheckpoint);
            this.appliedResolutionIds.add(resolution.resolutionId);
            this.lastLoadedHash = appliedHash;
        }
        if (appliedHash !== resolution.authoritativeHash) {
            this.fail('HASH_MISMATCH_ON_APPLY');
            this.leave('USER');
            return;
        }
        this.debug.confirmedStateHash = resolution.authoritativeHash;
        this.send('TURN_RESOLUTION_APPLIED', {
            matchId: resolution.matchId,
            completedTurnIndex: resolution.completedTurnIndex,
            resolutionId: resolution.resolutionId,
            appliedHash,
        });
        this.statusText = corrected ? '检测到失步，已采用房主状态' : '双方结果一致，等待下一回合';
    }

    private onMatchFinished(payload: unknown): void {
        const data = payload as { finalHash: string; redScore: number; blueScore: number };
        if (data.finalHash !== this.lastLoadedHash) {
            this.fail('FINAL_HASH_MISMATCH');
            return;
        }
        this.debug.roomState = 'FINISHED';
        this.debug.turnPhase = null;
        this.debug.turnIndex = 8;
        this.canLocalInput = false;
        this.statusText = `比赛结束：红 ${data.redScore} : ${data.blueScore} 蓝`;
    }

    private onMatchAborted(payload: unknown): void {
        const data = payload as { reasonCode: string; detail: string };
        this.debug.roomState = 'ABORTED';
        this.debug.turnPhase = null;
        this.canLocalInput = false;
        this.fail(`${data.reasonCode}: ${data.detail}`);
        this.statusText = `对局已终止：${data.reasonCode}`;
    }

    private onRoomLeft(): void {
        this.resetToLobbyState('已离开房间');
        this.transport.close();
    }

    private resetToLobbyState(statusText: string): void {
        this.inRoom = false;
        this.lobbyVisible = true;
        this.canLocalInput = false;
        this.activeShotId = '';
        this.submittedShotId = '';
        this.debug.matchId = '';
        this.debug.role = '';
        this.debug.camp = '';
        this.debug.roomState = '';
        this.debug.turnPhase = null;
        this.debug.turnIndex = 0;
        this.debug.expectedCamp = '';
        this.debug.intentId = '';
        this.debug.shotId = '';
        this.debug.resolutionId = '';
        this.debug.confirmedStateHash = '';
        this.debug.candidateStateHash = '';
        this.debug.remoteStateHash = '';
        this.debug.hashMatch = '';
        this.debug.desyncCorrectionCount = 0;
        this.debug.pingMs = 0;
        this.debug.clientSeq = 0;
        this.debug.serverSeq = 0;
        this.debug.lastError = '';
        this.bridge.returnToLobby();
        this.statusText = statusText;
    }

    private onPong(payload: unknown): void {
        const nonce = (payload as { nonce: string }).nonce;
        const started = this.pingStartedAt.get(nonce);
        if (started !== undefined) {
            this.debug.pingMs = nowMs() - started;
            this.pingStartedAt.delete(nonce);
        }
    }

    private onError(payload: unknown): void {
        const data = payload as { code: string; fatal: boolean; detail: string };
        this.fail(`${data.code}: ${data.detail}`);
        if (data.fatal) this.canLocalInput = false;
    }

    private send(type: string, payload: unknown): void {
        if (type === 'PING') {
            const nonce = (payload as { nonce: string }).nonce;
            this.pingStartedAt.set(nonce, nowMs());
        }
        this.transport.send(type, payload);
        this.debug.clientSeq = this.transport.clientSeq;
    }

    private fail(message: string): void {
        this.debug.lastError = message;
        this.statusText = message;
    }
}

function normalizeSimulationError(value: string): string {
    if (value.indexOf('PHYSICS_EVENT_LIMIT') >= 0) return 'PHYSICS_EVENT_LIMIT';
    if (value.indexOf('PHYSICS_POSITION_LIMIT') >= 0) return 'PHYSICS_POSITION_LIMIT';
    if (value.indexOf('NON_FINITE') >= 0) return 'NON_FINITE';
    return 'INTERNAL_ERROR';
}

function normalizeErrorCode(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'INTERNAL_ERROR';
}

function createUuid(): string {
    const nativeCrypto = typeof crypto !== 'undefined' ? crypto : null;
    if (nativeCrypto && typeof nativeCrypto.randomUUID === 'function') {
        return nativeCrypto.randomUUID().toLowerCase();
    }
    const bytes = new Uint8Array(16);
    if (nativeCrypto?.getRandomValues) nativeCrypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map(value => {
        const text = value.toString(16);
        return text.length < 2 ? `0${text}` : text;
    }).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function short(value: string): string {
    return value ? value.slice(0, 8) : '--';
}

function nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
