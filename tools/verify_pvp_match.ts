import { ArcShotConfig } from '../assets/scripts/core/ArcShotConfig';
import { MatchController } from '../assets/scripts/core/MatchController';
import { PhysicsWorld } from '../assets/scripts/core/PhysicsWorld';
import { checkpointHash } from '../assets/scripts/shared/CheckpointCodec';

function config(): ArcShotConfig {
    return {
        designWidth: 1080,
        referenceHeight: 2400,
        tableLeftX: -480,
        tableRightX: 480,
        tableBottomY: -1100,
        tableTopY: 900,
        fireLineY: -695,
        fireLineThickness: 8,
        discRadius: 45,
        targetCenterX: 0,
        targetCenterY: 590,
        scoreRingRadii: [45, 90, 135, 180, 225],
        scoreValues: [5, 4, 3, 2, 1],
        maxPullDistance: 240,
        aimActivationDistance: 45,
        allowLaunchPointDrag: false,
        minimumFireRatio: 0.05,
        targetTravelDistanceMax: 2046.154,
        speedCalibrationDistance: 2050.133,
        spinSliderOneWayTime: 1,
        curvePeakProgress: 0.82,
        curveStartStrength: 0.12,
        curveRiseExponent: 2.2,
        curveEnvelopeArea: 0.444930656,
        curveReferenceDistance: 1330,
        maxCurveHeadingDegrees: 45,
        collisionSpinRetention: 0.65,
        linearDeceleration: 650,
        stopSpeed: 45,
        collisionRestitution: 0.2,
        maxCollisionEventsPerMicrostep: 32,
        positionSlop: 0.01,
        maxPositionIterations: 16,
        settlingTime: 0.25,
    };
}

function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
}

function runFirstTurn(): { match: MatchController; hash: string; motionFrames: number } {
    const cfg = config();
    const match = new MatchController(cfg);
    const physics = new PhysicsWorld(cfg);
    match.setGameMode('LOCAL_WEB_PVP');
    const disc = match.currentDisc;
    assert(disc?.id === 'R1', 'R1 ready');
    if (!disc) throw new Error('R1 missing');
    physics.beginTurn();
    physics.createLaunchIgnorePairs(disc, match.discs);
    assert(match.applyCommittedShot({
        directionX: 0,
        directionY: 1,
        pullRatio: 0.65,
        curveRatio: 0,
    }), 'committed shot applies');

    let motionFrames = 0;
    while (match.state === 'TURN_SIMULATING' && motionFrames < 600) {
        physics.stepLogicFrame(match.discs);
        match.afterLogicFrame();
        motionFrames += 1;
    }
    assert(match.state === 'TURN_SETTLING', 'enters settling');
    assert(match.turnIndex === 0, 'turn does not advance at stop');
    assert(match.discs[1].state === 'UNUSED', 'next disc not loaded at stop');

    for (let index = 0; index < 14; index += 1) {
        match.afterLogicFrame();
        assert(match.getPendingCandidate() === null, `no candidate before frame ${index + 1}`);
    }
    match.afterLogicFrame();
    const candidate = match.getPendingCandidate();
    assert(match.state === 'TURN_NETWORK_WAIT', 'network wait after frame 15');
    assert(match.settlingFrames === 15, 'exactly 15 settling frames');
    assert(match.turnIndex === 0, 'actual turn still not advanced');
    assert(match.discs[1].state === 'UNUSED', 'actual next disc still absent');
    assert(candidate?.turnIndex === 1, 'candidate advances copy');
    assert(candidate?.discs[1].stateCode === 1, 'candidate contains B1 ready');
    if (!candidate) throw new Error('candidate missing');
    const hash = checkpointHash(candidate);

    physics.reset();
    const appliedHash = match.loadCheckpoint(candidate);
    assert(appliedHash === hash, 'load hash matches');
    assert(match.turnIndex === 1 && match.currentDisc?.id === 'B1', 'load advances exactly once');
    assert(match.currentDisc?.state === 'READY', 'B1 ready only after load');
    return { match, hash, motionFrames };
}

const left = runFirstTurn();
const right = runFirstTurn();
assert(left.hash === right.hash, 'independent clients produce same checkpoint');

console.log(JSON.stringify({
    status: 'PASS',
    candidateHash: left.hash,
    motionFrames: left.motionFrames,
    settlingFrames: left.match.settlingFrames,
    nextTurnIndex: left.match.turnIndex,
    nextDisc: left.match.currentDisc?.id,
}, null, 2));
