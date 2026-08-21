import { CheckpointV1, PvpCamp, PvpRole, ShotCommandQ } from './PvpTypes';
import { PVP_PROTOCOL_VERSION } from './RulesetManifest';

export type RoomState = 'WAITING' | 'STARTING' | 'PLAYING' | 'RESOLVING' | 'FINISHED' | 'ABORTED';
export type TurnPhase = 'WAITING_SHOT' | 'WAITING_RESULTS' | null;

export interface ClientEnvelope<T = unknown> {
    type: string;
    protocolVersion: typeof PVP_PROTOCOL_VERSION;
    clientSeq: number;
    payload: T;
}

export interface ServerEnvelope<T = unknown> {
    type: string;
    protocolVersion: typeof PVP_PROTOCOL_VERSION;
    serverSeq: number;
    payload: T;
}

export interface ShotIntentPayload extends ShotCommandQ {
    roomCode: string;
    matchId: string;
    turnIndex: number;
    intentId: string;
    preStateHash: string;
}

export interface ShotCommitPayload extends ShotIntentPayload {
    expectedCamp: PvpCamp;
    shotId: string;
}

export type SimulationStatus =
    | 'OK'
    | 'PHYSICS_EVENT_LIMIT'
    | 'PHYSICS_POSITION_LIMIT'
    | 'NON_FINITE'
    | 'INTERNAL_ERROR';

export interface TurnSettledPayload {
    roomCode: string;
    matchId: string;
    completedTurnIndex: number;
    shotId: string;
    stateHash: string | null;
    checkpoint: CheckpointV1 | null;
    simulationStatus: SimulationStatus;
    errorCode: string | null;
}

export interface TurnResolutionPayload {
    roomCode: string;
    matchId: string;
    completedTurnIndex: number;
    resolutionId: string;
    resolutionType: 'MATCHED' | 'HOST_OVERRIDE';
    authoritativeCheckpoint: CheckpointV1;
    authoritativeHash: string;
    nextTurnIndex: number;
    nextExpectedCamp: PvpCamp | null;
}

export interface MatchPreparePayload {
    roomCode: string;
    matchId: string;
    localRole: PvpRole;
    localCamp: PvpCamp;
    rulesetVersion: string;
    initialCheckpoint: CheckpointV1;
    initialStateHash: string;
    readyDeadlineMs: number;
}

export interface PvpDebugSnapshot {
    clientInstanceId: string;
    sessionId: string;
    roomCode: string;
    matchId: string;
    role: PvpRole | '';
    camp: PvpCamp | '';
    socketState: string;
    roomState: RoomState | '';
    turnPhase: TurnPhase;
    turnIndex: number;
    expectedCamp: PvpCamp | '';
    clientSeq: number;
    serverSeq: number;
    intentId: string;
    shotId: string;
    resolutionId: string;
    confirmedStateHash: string;
    candidateStateHash: string;
    remoteStateHash: string;
    hashMatch: string;
    desyncCorrectionCount: number;
    pingMs: number;
    simulatedLatencyMs: number;
    lastError: string;
}

export function expectedCampForTurn(turnIndex: number): PvpCamp {
    return turnIndex % 2 === 0 ? 'RED' : 'BLUE';
}

export function isHash8(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value);
}

export function isUuid(value: unknown): value is string {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isRoomCode(value: unknown): value is string {
    return typeof value === 'string' && /^\d{6}$/.test(value);
}

