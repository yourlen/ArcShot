import { fnv1aAscii, hasExactKeys, isSafeInteger, roundAway } from './CanonicalMath';
import { RULESET_MANIFEST, RulesetManifestV1 } from './RulesetManifest';
import {
    CheckpointDiscStateCode,
    CheckpointV1,
    DiscCheckpoint,
    WinnerCode,
} from './PvpTypes';

const CHECKPOINT_KEYS = [
    'schemaVersion', 'phaseCode', 'turnIndex', 'redScore', 'blueScore', 'winnerCode', 'discs',
];
const DISC_KEYS = ['idCode', 'stateCode', 'xQ', 'yQ'];

export function cloneCheckpoint(checkpoint: CheckpointV1): CheckpointV1 {
    return {
        ...checkpoint,
        discs: checkpoint.discs.map(disc => ({ ...disc })),
    };
}

export function quantizePosition(value: number): number {
    return roundAway(value * 1000);
}

export function dequantizePosition(value: number): number {
    return value / 1000;
}

export function scoreDiscCheckpoint(
    disc: DiscCheckpoint,
    manifest: RulesetManifestV1 = RULESET_MANIFEST,
): number {
    if (disc.stateCode !== 2) return 0;
    const distance = Math.hypot(
        disc.xQ - manifest.targetXQ,
        disc.yQ - manifest.targetYQ,
    );
    for (let index = 0; index < manifest.ringRadiiQ.length; index += 1) {
        if (distance < manifest.ringRadiiQ[index] + manifest.discRadiusQ) {
            return manifest.ringScores[index] ?? 0;
        }
    }
    return 0;
}

export function deriveCheckpointScores(
    discs: DiscCheckpoint[],
    manifest: RulesetManifestV1 = RULESET_MANIFEST,
): { redScore: number; blueScore: number } {
    let redScore = 0;
    let blueScore = 0;
    for (const disc of discs) {
        const score = scoreDiscCheckpoint(disc, manifest);
        if (disc.idCode % 2 === 0) redScore += score;
        else blueScore += score;
    }
    return { redScore, blueScore };
}

export function deriveWinnerCode(redScore: number, blueScore: number, finished: boolean): WinnerCode {
    if (!finished) return 0;
    if (redScore === blueScore) return 3;
    return redScore > blueScore ? 1 : 2;
}

export function canonicalCheckpoint(checkpoint: CheckpointV1): string {
    const ordered = [...checkpoint.discs].sort((left, right) => left.idCode - right.idCode);
    const discs = ordered
        .map(disc => `${disc.idCode},${disc.stateCode},${disc.xQ},${disc.yQ}`)
        .join(';');
    return [
        'ASCP1', checkpoint.phaseCode, checkpoint.turnIndex,
        checkpoint.redScore, checkpoint.blueScore, checkpoint.winnerCode, discs,
    ].join('|');
}

export function checkpointHash(checkpoint: CheckpointV1): string {
    return fnv1aAscii(canonicalCheckpoint(checkpoint));
}

export function validateCheckpoint(
    value: unknown,
    manifest: RulesetManifestV1 = RULESET_MANIFEST,
): string[] {
    const errors: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['SNAPSHOT_INVALID'];
    if (!hasExactKeys(value, CHECKPOINT_KEYS)) errors.push('CHECKPOINT_KEYS');
    const checkpoint = value as CheckpointV1;
    for (const key of ['schemaVersion', 'phaseCode', 'turnIndex', 'redScore', 'blueScore', 'winnerCode'] as const) {
        if (!isSafeInteger(checkpoint[key])) errors.push(`CHECKPOINT_${key.toUpperCase()}`);
    }
    if (checkpoint.schemaVersion !== 1) errors.push('CHECKPOINT_SCHEMA');
    if (checkpoint.phaseCode !== 0 && checkpoint.phaseCode !== 1) errors.push('CHECKPOINT_PHASE');
    if (checkpoint.turnIndex < 0 || checkpoint.turnIndex > 8) errors.push('CHECKPOINT_TURN');
    if (checkpoint.redScore < 0 || checkpoint.redScore > 20) errors.push('CHECKPOINT_RED_SCORE');
    if (checkpoint.blueScore < 0 || checkpoint.blueScore > 20) errors.push('CHECKPOINT_BLUE_SCORE');
    if ([0, 1, 2, 3].indexOf(checkpoint.winnerCode) < 0) errors.push('CHECKPOINT_WINNER');
    if (!Array.isArray(checkpoint.discs) || checkpoint.discs.length !== 8) {
        errors.push('CHECKPOINT_DISC_COUNT');
        return errors;
    }

    const ordered = [...checkpoint.discs].sort((left, right) => left.idCode - right.idCode);
    for (let index = 0; index < ordered.length; index += 1) {
        const disc = ordered[index];
        if (!disc || typeof disc !== 'object' || Array.isArray(disc)) {
            errors.push(`DISC_${index}_INVALID`);
            continue;
        }
        if (!hasExactKeys(disc, DISC_KEYS)) errors.push(`DISC_${index}_KEYS`);
        if (disc.idCode !== index) errors.push(`DISC_${index}_ID`);
        if ([0, 1, 2, 3].indexOf(disc.stateCode) < 0) errors.push(`DISC_${index}_STATE`);
        if (!isSafeInteger(disc.xQ) || !isSafeInteger(disc.yQ)) errors.push(`DISC_${index}_POSITION`);
        if (Math.abs(disc.xQ) > 10_000_000 || Math.abs(disc.yQ) > 10_000_000) {
            errors.push(`DISC_${index}_POSITION_RANGE`);
        }
        if ((disc.stateCode === 0 || disc.stateCode === 3) && (disc.xQ !== 0 || disc.yQ !== 0)) {
            errors.push(`DISC_${index}_ZERO_POSITION`);
        }
        if (disc.stateCode === 2 && (
            disc.xQ < manifest.leftBoundaryQ
            || disc.xQ > manifest.rightBoundaryQ
            || disc.yQ > manifest.topBoundaryQ
        )) {
            errors.push(`DISC_${index}_STOPPED_OUTSIDE`);
        }
    }

    if (checkpoint.turnIndex < 8) {
        if (checkpoint.phaseCode !== 0 || checkpoint.winnerCode !== 0) errors.push('TURN_READY_PHASE');
        for (let index = 0; index < 8; index += 1) {
            const disc = ordered[index];
            if (!disc) continue;
            if (index < checkpoint.turnIndex && disc.stateCode !== 2 && disc.stateCode !== 3) {
                errors.push(`DISC_${index}_PAST_STATE`);
            } else if (index === checkpoint.turnIndex && (
                disc.stateCode !== 1
                || disc.xQ !== manifest.launchXQ
                || disc.yQ !== manifest.launchYQ
            )) {
                errors.push(`DISC_${index}_READY_STATE`);
            } else if (index > checkpoint.turnIndex && disc.stateCode !== 0) {
                errors.push(`DISC_${index}_FUTURE_STATE`);
            }
        }
    } else {
        if (checkpoint.phaseCode !== 1) errors.push('MATCH_RESULT_PHASE');
        if (ordered.some(disc => disc.stateCode !== 2 && disc.stateCode !== 3)) {
            errors.push('MATCH_RESULT_DISC_STATE');
        }
    }

    const scores = deriveCheckpointScores(ordered, manifest);
    if (checkpoint.redScore !== scores.redScore || checkpoint.blueScore !== scores.blueScore) {
        errors.push('CHECKPOINT_SCORE_MISMATCH');
    }
    const winner = deriveWinnerCode(scores.redScore, scores.blueScore, checkpoint.turnIndex === 8);
    if (checkpoint.winnerCode !== winner) errors.push('CHECKPOINT_WINNER_MISMATCH');
    return errors;
}

export function createDiscCheckpoint(
    idCode: number,
    stateCode: CheckpointDiscStateCode,
    x: number,
    y: number,
): DiscCheckpoint {
    return {
        idCode,
        stateCode,
        xQ: stateCode === 0 || stateCode === 3 ? 0 : quantizePosition(x),
        yQ: stateCode === 0 || stateCode === 3 ? 0 : quantizePosition(y),
    };
}
