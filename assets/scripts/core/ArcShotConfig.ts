export const LOGIC_HZ = 60;
export const LOGIC_DT = 1 / LOGIC_HZ;
export const MICRO_STEPS_PER_LOGIC_FRAME = 4;
export const MICRO_DT = LOGIC_DT / MICRO_STEPS_PER_LOGIC_FRAME;
export const MAX_LOGIC_FRAMES_PER_RENDER = 4;
export const EVENT_SIMULTANEOUS_TOLERANCE = 1e-7;

export interface ArcShotConfig {
    designWidth: number;
    referenceHeight: number;
    tableLeftX: number;
    tableRightX: number;
    tableBottomY: number;
    tableTopY: number;
    fireLineY: number;
    fireLineThickness: number;
    discRadius: number;
    targetCenterX: number;
    targetCenterY: number;
    scoreRingRadii: number[];
    scoreValues: number[];

    maxPullDistance: number;
    aimActivationDistance: number;
    allowLaunchPointDrag: boolean;
    minimumFireRatio: number;
    targetTravelDistanceMax: number;
    speedCalibrationDistance: number;

    spinSliderOneWayTime: number;
    curvePeakProgress: number;
    curveStartStrength: number;
    curveRiseExponent: number;
    curveEnvelopeArea: number;
    curveReferenceDistance: number;
    maxCurveHeadingDegrees: number;
    collisionSpinRetention: number;

    linearDeceleration: number;
    stopSpeed: number;
    collisionRestitution: number;
    maxCollisionEventsPerMicrostep: number;
    positionSlop: number;
    maxPositionIterations: number;
    settlingTime: number;
}

export function validateArcShotConfig(config: ArcShotConfig): string[] {
    const errors: string[] = [];
    for (const name of Object.keys(config) as Array<keyof ArcShotConfig>) {
        const value = config[name];
        if (typeof value === 'number' && !Number.isFinite(value)) {
            errors.push(`${String(name)} must be finite`);
        }
    }

    if (!(config.discRadius > 0)) errors.push('discRadius must be > 0');
    if (!(config.tableLeftX < config.tableRightX)) errors.push('tableLeftX must be < tableRightX');
    if (config.tableRightX - config.tableLeftX < config.discRadius * 2) {
        errors.push('table width must be >= 2 * discRadius');
    }
    if (config.scoreRingRadii.length !== 5) errors.push('scoreRingRadii must contain 5 values');
    if (config.scoreValues.length !== 5) errors.push('scoreValues must contain 5 values');
    if (!isStrictlyIncreasingPositive(config.scoreRingRadii)) {
        errors.push('scoreRingRadii must be positive and strictly increasing');
    }
    if (!config.scoreValues.every(value => Number.isFinite(value))) {
        errors.push('scoreValues must be finite');
    }
    if (!(config.maxPullDistance > 0)) errors.push('maxPullDistance must be > 0');
    if (!(config.minimumFireRatio > 0 && config.minimumFireRatio <= 1)) {
        errors.push('minimumFireRatio must be in (0, 1]');
    }
    if (!(
        config.aimActivationDistance > 0
        && config.aimActivationDistance < config.maxPullDistance
    )) {
        errors.push('aimActivationDistance must be > 0 and < maxPullDistance');
    }
    if (!(config.spinSliderOneWayTime > 0)) errors.push('spinSliderOneWayTime must be > 0');
    if (!(config.targetTravelDistanceMax > 0)) {
        errors.push('targetTravelDistanceMax must be > 0');
    }
    if (!(config.speedCalibrationDistance > 0)) {
        errors.push('speedCalibrationDistance must be > 0');
    }
    if (!(config.curvePeakProgress > 0 && config.curvePeakProgress < 1)) {
        errors.push('curvePeakProgress must be in (0, 1)');
    }
    if (!(config.curveStartStrength >= 0 && config.curveStartStrength <= 1)) {
        errors.push('curveStartStrength must be in [0, 1]');
    }
    if (!(config.curveRiseExponent > 0)) errors.push('curveRiseExponent must be > 0');
    if (!(config.curveEnvelopeArea > 0)) errors.push('curveEnvelopeArea must be > 0');
    if (!(config.curveReferenceDistance > 0)) {
        errors.push('curveReferenceDistance must be > 0');
    }
    if (!(config.maxCurveHeadingDegrees >= 0)) {
        errors.push('maxCurveHeadingDegrees must be >= 0');
    }
    if (!(config.collisionRestitution >= 0 && config.collisionRestitution <= 1)) {
        errors.push('collisionRestitution must be in [0, 1]');
    }
    if (!(config.collisionSpinRetention >= 0 && config.collisionSpinRetention <= 1)) {
        errors.push('collisionSpinRetention must be in [0, 1]');
    }
    if (!(config.linearDeceleration > 0)) errors.push('linearDeceleration must be > 0');
    if (!(config.stopSpeed >= 0)) errors.push('stopSpeed must be >= 0');
    if (!Number.isInteger(config.maxCollisionEventsPerMicrostep)
        || config.maxCollisionEventsPerMicrostep <= 0) {
        errors.push('maxCollisionEventsPerMicrostep must be a positive integer');
    }
    if (!(config.positionSlop >= 0 && config.positionSlop < 0.5)) {
        errors.push('positionSlop must be in [0, 0.5)');
    }
    if (!Number.isInteger(config.maxPositionIterations) || config.maxPositionIterations <= 0) {
        errors.push('maxPositionIterations must be a positive integer');
    }
    if (!(config.settlingTime >= 0)) errors.push('settlingTime must be >= 0');
    return errors;
}

export function targetTravelDistance(config: ArcShotConfig, pullRatio: number): number {
    return config.targetTravelDistanceMax * clamp01(pullRatio);
}

export function initialSpeedForPullRatio(config: ArcShotConfig, pullRatio: number): number {
    const ratio = clamp01(pullRatio);
    return Math.sqrt(
        config.stopSpeed * config.stopSpeed
        + 2 * config.linearDeceleration * config.speedCalibrationDistance * ratio,
    );
}

export function curveEnvelope(config: ArcShotConfig, progress: number): number {
    const u = clamp01(progress);
    const rise = smoothstep(0, config.curvePeakProgress, u);
    const fall = 1 - smoothstep(config.curvePeakProgress, 1, u);
    return (
        config.curveStartStrength
        + (1 - config.curveStartStrength) * Math.pow(rise, config.curveRiseExponent)
    ) * fall;
}

function smoothstep(start: number, end: number, value: number): number {
    if (value <= start) return 0;
    if (value >= end) return 1;
    const t = (value - start) / (end - start);
    return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function isStrictlyIncreasingPositive(values: number[]): boolean {
    let previous = 0;
    for (const value of values) {
        if (!Number.isFinite(value) || value <= previous) {
            return false;
        }
        previous = value;
    }
    return true;
}
