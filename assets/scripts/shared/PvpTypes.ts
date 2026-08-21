export type PvpCamp = 'RED' | 'BLUE';
export type PvpRole = 'HOST' | 'GUEST';

export type CheckpointPhaseCode = 0 | 1;
export type CheckpointDiscStateCode = 0 | 1 | 2 | 3;
export type WinnerCode = 0 | 1 | 2 | 3;

export interface DiscCheckpoint {
    idCode: number;
    stateCode: CheckpointDiscStateCode;
    xQ: number;
    yQ: number;
}

export interface CheckpointV1 {
    schemaVersion: 1;
    phaseCode: CheckpointPhaseCode;
    turnIndex: number;
    redScore: number;
    blueScore: number;
    winnerCode: WinnerCode;
    discs: DiscCheckpoint[];
}

export interface ShotCommandQ {
    directionXQ: number;
    directionYQ: number;
    pullRatioQ: number;
    curveRatioQ: number;
}

export interface ShotCommand {
    directionX: number;
    directionY: number;
    pullRatio: number;
    curveRatio: number;
}

