import { hasExactKeys, isSafeInteger, roundAway } from './CanonicalMath';
import { ShotCommand, ShotCommandQ } from './PvpTypes';

const DIRECTION_SCALE = 1_000_000;
const RATIO_SCALE = 10_000;

export function quantizeShotCommand(command: ShotCommand): ShotCommandQ {
    const length = Math.hypot(command.directionX, command.directionY);
    if (!(length > 0) || !Number.isFinite(length)) throw new Error('INVALID_DIRECTION');
    return {
        directionXQ: roundAway(command.directionX / length * DIRECTION_SCALE),
        directionYQ: roundAway(command.directionY / length * DIRECTION_SCALE),
        pullRatioQ: roundAway(command.pullRatio * RATIO_SCALE),
        curveRatioQ: roundAway(command.curveRatio * RATIO_SCALE),
    };
}

export function validateShotCommandQ(value: unknown): string[] {
    const errors: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['INVALID_COMMAND'];
    if (!hasExactKeys(value, ['directionXQ', 'directionYQ', 'pullRatioQ', 'curveRatioQ'])) {
        errors.push('INVALID_COMMAND_KEYS');
    }
    const command = value as ShotCommandQ;
    for (const key of ['directionXQ', 'directionYQ', 'pullRatioQ', 'curveRatioQ'] as const) {
        if (!isSafeInteger(command[key])) errors.push(`INVALID_${key.toUpperCase()}`);
    }
    if (errors.length > 0) return errors;
    if (command.directionXQ < -DIRECTION_SCALE || command.directionXQ > DIRECTION_SCALE) {
        errors.push('INVALID_DIRECTION_X');
    }
    if (command.directionYQ < 1 || command.directionYQ > DIRECTION_SCALE) {
        errors.push('INVALID_DIRECTION_Y');
    }
    if (Math.abs(Math.hypot(command.directionXQ, command.directionYQ) - DIRECTION_SCALE) > 4) {
        errors.push('INVALID_DIRECTION_LENGTH');
    }
    if (command.pullRatioQ < 500 || command.pullRatioQ > RATIO_SCALE) {
        errors.push('INVALID_PULL_RATIO');
    }
    if (command.curveRatioQ < -RATIO_SCALE || command.curveRatioQ > RATIO_SCALE) {
        errors.push('INVALID_CURVE_RATIO');
    }
    return errors;
}

export function dequantizeShotCommand(command: ShotCommandQ): ShotCommand {
    const errors = validateShotCommandQ(command);
    if (errors.length > 0) throw new Error(errors.join(','));
    const x = command.directionXQ / DIRECTION_SCALE;
    const y = command.directionYQ / DIRECTION_SCALE;
    const length = Math.hypot(x, y);
    return {
        directionX: x / length,
        directionY: y / length,
        pullRatio: command.pullRatioQ / RATIO_SCALE,
        curveRatio: command.curveRatioQ / RATIO_SCALE,
    };
}

export function canonicalShotCommand(command: ShotCommandQ): string {
    const errors = validateShotCommandQ(command);
    if (errors.length > 0) throw new Error(errors.join(','));
    return [command.directionXQ, command.directionYQ, command.pullRatioQ, command.curveRatioQ].join('|');
}

