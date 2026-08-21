import { fnv1aAscii } from './CanonicalMath';
import { CheckpointV1 } from './PvpTypes';

export const PVP_PROTOCOL_VERSION = 'arcshot-pvp-local/0.2';
export const PVP_RULESET_VERSION = 'arcshot-local-20260821-r1';

export interface RulesetManifestV1 {
    schemaVersion: 1;
    protocolVersion: string;
    rulesetVersion: string;
    designWidthQ: number;
    designHeightQ: number;
    leftBoundaryQ: number;
    rightBoundaryQ: number;
    topBoundaryQ: number;
    hasBottomBoundary: boolean;
    launchLineYQ: number;
    discRadiusQ: number;
    launchXQ: number;
    launchYQ: number;
    targetXQ: number;
    targetYQ: number;
    ringRadiiQ: number[];
    ringScores: number[];
    maxPullDistanceQ: number;
    aimActivationDistanceQ: number;
    minPullRatioQ: number;
    maxDisplayTravelQ: number;
    speedCalibrationTravelQ: number;
    sliderOneWayMs: number;
    sliderFreezeMs: number;
    curveReferenceDistanceQ: number;
    curvePeakRatioQ: number;
    curveStartStrengthRatioQ: number;
    curveRiseExponentQ: number;
    curveEnvelopeAreaRatioQ: number;
    maxTurnMicroDegrees: number;
    collisionCurveRetentionRatioQ: number;
    linearDecelerationQ: number;
    stopSpeedQ: number;
    restitutionRatioQ: number;
    logicHz: number;
    physicsMicroHz: number;
    sameTimeToleranceNanoseconds: number;
    eventLimit: number;
    positionIterationLimit: number;
    turnSettlingMs: number;
    discOrder: number[];
    initialCheckpoint: CheckpointV1;
    initialStateHash: string;
    manifestHash: string;
}

export const INITIAL_CHECKPOINT: CheckpointV1 = {
    schemaVersion: 1,
    phaseCode: 0,
    turnIndex: 0,
    redScore: 0,
    blueScore: 0,
    winnerCode: 0,
    discs: [
        { idCode: 0, stateCode: 1, xQ: 0, yQ: -740000 },
        { idCode: 1, stateCode: 0, xQ: 0, yQ: 0 },
        { idCode: 2, stateCode: 0, xQ: 0, yQ: 0 },
        { idCode: 3, stateCode: 0, xQ: 0, yQ: 0 },
        { idCode: 4, stateCode: 0, xQ: 0, yQ: 0 },
        { idCode: 5, stateCode: 0, xQ: 0, yQ: 0 },
        { idCode: 6, stateCode: 0, xQ: 0, yQ: 0 },
        { idCode: 7, stateCode: 0, xQ: 0, yQ: 0 },
    ],
};

export const RULESET_MANIFEST: RulesetManifestV1 = {
    schemaVersion: 1,
    protocolVersion: PVP_PROTOCOL_VERSION,
    rulesetVersion: PVP_RULESET_VERSION,
    designWidthQ: 1080000,
    designHeightQ: 2400000,
    leftBoundaryQ: -480000,
    rightBoundaryQ: 480000,
    topBoundaryQ: 900000,
    hasBottomBoundary: false,
    launchLineYQ: -695000,
    discRadiusQ: 45000,
    launchXQ: 0,
    launchYQ: -740000,
    targetXQ: 0,
    targetYQ: 590000,
    ringRadiiQ: [45000, 90000, 135000, 180000, 225000],
    ringScores: [5, 4, 3, 2, 1],
    maxPullDistanceQ: 240000,
    aimActivationDistanceQ: 45000,
    minPullRatioQ: 50000,
    maxDisplayTravelQ: 2046154,
    speedCalibrationTravelQ: 2050133,
    sliderOneWayMs: 1000,
    sliderFreezeMs: 150,
    curveReferenceDistanceQ: 1330000,
    curvePeakRatioQ: 820000,
    curveStartStrengthRatioQ: 120000,
    curveRiseExponentQ: 2200000,
    curveEnvelopeAreaRatioQ: 444931,
    maxTurnMicroDegrees: 45000000,
    collisionCurveRetentionRatioQ: 650000,
    linearDecelerationQ: 650000,
    stopSpeedQ: 45000,
    restitutionRatioQ: 200000,
    logicHz: 60,
    physicsMicroHz: 240,
    sameTimeToleranceNanoseconds: 100,
    eventLimit: 32,
    positionIterationLimit: 16,
    turnSettlingMs: 250,
    discOrder: [0, 1, 2, 3, 4, 5, 6, 7],
    initialCheckpoint: INITIAL_CHECKPOINT,
    initialStateHash: 'dba54029',
    manifestHash: 'e98b3f53',
};

export function canonicalRulesetManifest(manifest = RULESET_MANIFEST): string {
    return [
        'ASRM1',
        manifest.protocolVersion,
        manifest.rulesetVersion,
        manifest.designWidthQ,
        manifest.designHeightQ,
        manifest.leftBoundaryQ,
        manifest.rightBoundaryQ,
        manifest.topBoundaryQ,
        manifest.hasBottomBoundary ? 1 : 0,
        manifest.launchLineYQ,
        manifest.discRadiusQ,
        manifest.launchXQ,
        manifest.launchYQ,
        manifest.targetXQ,
        manifest.targetYQ,
        manifest.ringRadiiQ.join(','),
        manifest.ringScores.join(','),
        manifest.maxPullDistanceQ,
        manifest.aimActivationDistanceQ,
        manifest.minPullRatioQ,
        manifest.maxDisplayTravelQ,
        manifest.speedCalibrationTravelQ,
        manifest.sliderOneWayMs,
        manifest.sliderFreezeMs,
        manifest.curveReferenceDistanceQ,
        manifest.curvePeakRatioQ,
        manifest.curveStartStrengthRatioQ,
        manifest.curveRiseExponentQ,
        manifest.curveEnvelopeAreaRatioQ,
        manifest.maxTurnMicroDegrees,
        manifest.collisionCurveRetentionRatioQ,
        manifest.linearDecelerationQ,
        manifest.stopSpeedQ,
        manifest.restitutionRatioQ,
        manifest.logicHz,
        manifest.physicsMicroHz,
        manifest.sameTimeToleranceNanoseconds,
        manifest.eventLimit,
        manifest.positionIterationLimit,
        manifest.turnSettlingMs,
        manifest.discOrder.join(','),
        manifest.initialStateHash,
    ].join('|');
}

export function verifyRulesetManifest(manifest = RULESET_MANIFEST): string[] {
    const errors: string[] = [];
    if (manifest.protocolVersion !== PVP_PROTOCOL_VERSION) errors.push('PROTOCOL_MISMATCH');
    if (manifest.rulesetVersion !== PVP_RULESET_VERSION) errors.push('RULESET_MISMATCH');
    if (fnv1aAscii(canonicalRulesetManifest(manifest)) !== manifest.manifestHash) {
        errors.push('MANIFEST_HASH_MISMATCH');
    }
    return errors;
}
