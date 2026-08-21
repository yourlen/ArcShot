import {
    ArcShotConfig,
    curveEnvelope,
    initialSpeedForPullRatio,
    targetTravelDistance,
    validateArcShotConfig,
} from '../assets/scripts/core/ArcShotConfig';
import { AimController } from '../assets/scripts/core/AimController';
import { createDefaultDiscs, DiscModel } from '../assets/scripts/core/DiscModel';
import { MatchController } from '../assets/scripts/core/MatchController';
import { PhysicsWorld, resolveEqualMassCollision } from '../assets/scripts/core/PhysicsWorld';

function config(overrides: Partial<ArcShotConfig> = {}): ArcShotConfig {
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
        spinSliderOneWayTime: 0.6,
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
        ...overrides,
    };
}

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

function near(actual: number, expected: number, tolerance: number, message: string): void {
    assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

function simulateSingle(spin: number, logicFrames: number, pullRatio = 0.75): DiscModel {
    const cfg = config();
    const disc = new DiscModel('R1', 'RED', 0, cfg.discRadius);
    disc.state = 'MOVING';
    disc.x = 0;
    disc.y = -740;
    disc.vx = 0;
    disc.vy = initialSpeedForPullRatio(cfg, pullRatio);
    disc.spin = spin;
    disc.capturedSpinRatio = spin;
    disc.plannedDistance = targetTravelDistance(cfg, pullRatio);
    const world = new PhysicsWorld(cfg);
    for (let frame = 0; frame < logicFrames && disc.state === 'MOVING'; frame += 1) {
        world.stepLogicFrame([disc]);
    }
    return disc;
}

function simulateFree(pullRatio: number, spin = 0): DiscModel {
    const cfg = config({
        tableLeftX: -100000,
        tableRightX: 100000,
        tableTopY: 100000,
    });
    const disc = new DiscModel('R1', 'RED', 0, cfg.discRadius);
    disc.state = 'MOVING';
    disc.x = 0;
    disc.y = -740;
    disc.vy = initialSpeedForPullRatio(cfg, pullRatio);
    disc.spin = spin;
    disc.capturedSpinRatio = spin;
    disc.plannedDistance = targetTravelDistance(cfg, pullRatio);
    const world = new PhysicsWorld(cfg);
    for (let frame = 0; frame < 2000 && disc.state === 'MOVING'; frame += 1) {
        world.stepLogicFrame([disc]);
    }
    return disc;
}

function run(): void {
    const cfg = config();
    assert(validateArcShotConfig(cfg).length === 0, 'default config must validate');

    near(curveEnvelope(cfg, 0), 0.12, 1e-12, 'curve envelope start');
    near(curveEnvelope(cfg, 0.82), 1, 1e-12, 'curve envelope peak');
    near(curveEnvelope(cfg, 1), 0, 1e-12, 'curve envelope end');
    let sampledPeakU = 0;
    let sampledPeakValue = -1;
    for (let index = 0; index <= 1000; index += 1) {
        const u = index / 1000;
        const value = curveEnvelope(cfg, u);
        if (value > sampledPeakValue) {
            sampledPeakValue = value;
            sampledPeakU = u;
        }
    }
    assert(sampledPeakU >= 0.80 && sampledPeakU <= 0.84,
        `curve envelope peak must remain in [0.80,0.84], got ${sampledPeakU}`);

    const powerDistances: number[] = [];
    for (let index = 1; index <= 20; index += 1) {
        const ratio = index * 0.05;
        const result = simulateFree(ratio);
        const distance = Math.hypot(result.x, result.y + 740);
        const expectedDistance = cfg.targetTravelDistanceMax * ratio;
        near(distance, expectedDistance, 3, `linear distance at ${(ratio * 100).toFixed(0)}%`);
        powerDistances.push(distance);
        near(result.actualTravelDistance, result.pathLength, 1e-7,
            `segmented actual travel must equal path length at ${(ratio * 100).toFixed(0)}%`);
    }
    const increments = powerDistances.slice(1).map((distance, index) => (
        distance - powerDistances[index]
    ));
    const meanIncrement = increments.reduce((sum, value) => sum + value, 0) / increments.length;
    for (const increment of increments) {
        assert(Math.abs(increment - meanIncrement) / meanIncrement <= 0.10,
            `power-grid increment ${increment} must remain within 10% of ${meanIncrement}`);
    }

    const returnMatch = new MatchController(cfg);
    const returnAim = new AimController();
    const returnDisc = returnMatch.currentDisc;
    if (!returnDisc) throw new Error('missing return-to-ready test disc');
    const returnStartX = returnDisc.x;
    const returnStartY = returnDisc.y;
    assert(returnAim.tryBeginTouch(3, returnStartX, returnStartY, returnDisc),
        'return-to-ready test touch must be captured');
    returnAim.moveTouch(3, returnStartX, returnStartY - 44, returnDisc, returnMatch, cfg);
    assert(returnMatch.state === 'TURN_READY', '44-unit downward drag must remain READY');
    returnAim.moveTouch(3, returnStartX, returnStartY - 45, returnDisc, returnMatch, cfg);
    assert(returnMatch.state === 'TURN_AIMING', '45-unit downward drag must enter AIMING');
    returnAim.moveTouch(3, returnStartX, returnStartY, returnDisc, returnMatch, cfg);
    assert(returnMatch.state === 'TURN_READY'
        && returnDisc.state === 'READY'
        && returnAim.activeTouchId === 3,
    'horizontal/downward launch direction must return to READY while keeping touch ownership');
    returnAim.moveTouch(3, returnStartX + 100, returnStartY, returnDisc, returnMatch, cfg);
    near(returnDisc.x, returnStartX, 1e-9,
        'disabled launch-point drag must keep the READY disc centered');
    const invalidLaunch = returnAim.releaseTouch(
        3,
        returnStartX + 100,
        returnStartY,
        returnDisc,
        returnMatch,
        cfg,
    );
    assert(invalidLaunch === null
        && returnAim.activeTouchId === -1
        && returnMatch.state === 'TURN_READY',
    'ending the kept touch in READY must not launch or consume the turn');

    const dragCfg = config({ allowLaunchPointDrag: true });
    const dragMatch = new MatchController(dragCfg);
    const dragAim = new AimController();
    const dragDisc = dragMatch.currentDisc;
    if (!dragDisc) throw new Error('missing launch-point toggle test disc');
    assert(dragAim.tryBeginTouch(4, dragDisc.x, dragDisc.y, dragDisc),
        'launch-point toggle test touch must be captured');
    dragAim.moveTouch(4, dragDisc.x + 100, dragDisc.y, dragDisc, dragMatch, dragCfg);
    near(dragDisc.x, 100, 1e-9, 'launch-point drag must remain available when re-enabled');
    dragAim.cancel(dragMatch);

    const inputMatch = new MatchController(cfg);
    const inputAim = new AimController();
    const inputDisc = inputMatch.currentDisc;
    assert(inputDisc !== null, 'input test must have a current disc');
    if (!inputDisc) throw new Error('missing input disc');
    assert(inputAim.tryBeginTouch(1, inputDisc.x, inputDisc.y, inputDisc),
        'touch on READY disc must be captured');
    inputAim.moveTouch(1, inputDisc.x, inputDisc.y - 120, inputDisc, inputMatch, cfg);
    assert(inputMatch.state === 'TURN_AIMING', 'downward drag must enter aiming');
    near(inputAim.sliderRatio, 0, 1e-9, 'slider must start centered');
    inputAim.updateSlider(cfg.spinSliderOneWayTime * 0.5, inputDisc, cfg);
    near(inputAim.sliderRatio, 1, 1e-9, 'half one-way time from center must reach +1');
    const inputLaunch = inputAim.releaseTouch(1, inputDisc.x, inputDisc.y - 120, inputDisc, inputMatch, cfg);
    assert(inputLaunch !== null, 'releasing at the right endpoint must produce a launch snapshot');
    if (!inputLaunch) throw new Error('missing input launch');
    near(inputLaunch.initialSpin, 1, 1e-9,
        'initial spin must be independent from pull strength');

    const renderedMatch = new MatchController(cfg);
    const renderedAim = new AimController();
    const renderedDisc = renderedMatch.currentDisc;
    if (!renderedDisc) throw new Error('missing rendered-slider test disc');
    assert(renderedAim.tryBeginTouch(2, renderedDisc.x, renderedDisc.y, renderedDisc),
        'rendered-slider test touch must be captured');
    renderedAim.moveTouch(2, renderedDisc.x, renderedDisc.y - 120, renderedDisc, renderedMatch, cfg);
    renderedAim.sliderRatio = 1;
    const centeredLaunch = renderedAim.releaseTouch(
        2,
        renderedDisc.x,
        renderedDisc.y - 120,
        renderedDisc,
        renderedMatch,
        cfg,
        0,
    );
    assert(centeredLaunch !== null, 'rendered-slider test must produce a launch snapshot');
    near(centeredLaunch?.spinRatio ?? 999, 0, 1e-9,
        'release must capture the last rendered slider ratio');
    near(centeredLaunch?.initialSpin ?? 999, 0, 1e-9,
        'a visually centered slider must always launch with zero spin');

    const straight = simulateSingle(0, 1000, 0.65);
    assert(straight.state === 'STOPPED', '65% straight shot must stop on table');
    assert(straight.motionTime > 1, '65% straight motion must last more than one second');
    assert(Math.hypot(straight.x, straight.y - cfg.targetCenterY) <= cfg.discRadius,
        '65% straight shot must stop within one radius of target center');
    const placementStraight = simulateSingle(0, 1000, 0.25);
    assert(placementStraight.state === 'STOPPED'
        && placementStraight.y > cfg.fireLineY
        && placementStraight.y < cfg.targetCenterY,
    '25% straight shot must stop between the fire line and target center');
    const attackStraight = simulateSingle(0, 1000, 0.75);
    assert(attackStraight.state === 'STOPPED'
        && attackStraight.y > cfg.targetCenterY
        && attackStraight.y < cfg.tableTopY,
    '75% unobstructed straight shot must pass the target and stop before the top boundary');
    const attackInitialSpeed = initialSpeedForPullRatio(cfg, 0.75);
    const attackSpeedAtTarget = Math.sqrt(
        attackInitialSpeed * attackInitialSpeed
        - 2 * cfg.linearDeceleration * cfg.curveReferenceDistance,
    );
    near(attackSpeedAtTarget, 521.44, 0.1,
        '75% straight shot must retain the calibrated impact speed at target distance');
    const fullStraight = simulateSingle(0, 1000, 1);
    assert(String(fullStraight.state) === 'OUT' && fullStraight.y >= cfg.tableTopY,
        '100% straight shot must carry top-boundary OUT risk');

    const rightCurve = simulateSingle(1, 1000, 0.65);
    const noCurve = simulateSingle(0, 1000, 0.65);
    const leftCurve = simulateSingle(-1, 1000, 0.65);
    near(rightCurve.x, 360.96, 2, '65% positive full curve gold X');
    near(rightCurve.y, 491.77, 2, '65% positive full curve gold Y');
    near(leftCurve.x, -360.96, 2, '65% negative full curve gold X');
    near(leftCurve.y, 491.77, 2, '65% negative full curve gold Y');
    assert(Math.abs(noCurve.x) < 1, 'zero curve amplitude must remain straight');
    near(leftCurve.x, -rightCurve.x, 0.01, 'opposite curve amplitudes must mirror X');
    near(leftCurve.y, rightCurve.y, 0.01, 'opposite curve amplitudes must preserve Y');
    near(rightCurve.curveProgress, 1, 1e-7, 'full free trajectory must consume curve progress');
    near(rightCurve.spin, 0, 1e-9, 'stopping must clear curve amplitude');
    const attackCurve = simulateFree(0.75, 1);
    near(attackCurve.x, 506.02, 2,
        '75% full curve must use the fixed 1330-unit curve reference distance');
    near(attackCurve.y, 636.47, 2,
        '75% full curve endpoint must preserve the fixed-reference gold result');
    const partialCurveGold = [
        { spin: 0.25, x: 95.18, y: 583.65 },
        { spin: 0.50, x: 188.34, y: 564.77 },
        { spin: 0.75, x: 277.55, y: 533.86 },
    ];
    for (const gold of partialCurveGold) {
        const result = simulateSingle(gold.spin, 1000, 0.65);
        near(result.x, gold.x, 2, `65% curve ${gold.spin} gold X`);
        near(result.y, gold.y, 2, `65% curve ${gold.spin} gold Y`);
    }
    assert(leftCurve.trail.length > 2, 'moving disc must retain visible trajectory points');

    const rawCollision = resolveEqualMassCollision(100, 0, 0, 0, 1, 0, cfg.collisionRestitution);
    near(rawCollision.aVx, 40, 0.001, 'raw collision A speed');
    near(rawCollision.bVx, 60, 0.001, 'raw collision B speed');
    const strongCollision = resolveEqualMassCollision(1000, 0, 0, 0, 1, 0, cfg.collisionRestitution);
    near(strongCollision.aVx, 400, 0.001, 'strong collision A speed');
    near(strongCollision.bVx, 600, 0.001, 'strong collision B speed');

    const collisionDiscs = createDefaultDiscs(cfg.discRadius).slice(0, 2);
    const [a, b] = collisionDiscs;
    a.state = 'MOVING';
    a.x = 0;
    a.y = 0;
    a.vx = 100;
    b.state = 'STOPPED';
    b.x = 90;
    b.y = 0;
    const collisionWorld = new PhysicsWorld(cfg);
    collisionWorld.stepLogicFrame(collisionDiscs);
    assert(String(a.state) === 'STOPPED', 'low post-collision A speed must stop');
    assert(String(b.state) === 'MOVING', 'stopped B must return to moving after collision');

    const retentionA = new DiscModel('R1', 'RED', 0, cfg.discRadius);
    const retentionB = new DiscModel('B1', 'BLUE', 1, cfg.discRadius);
    retentionA.state = 'MOVING';
    retentionA.x = 0;
    retentionA.vx = 1000;
    retentionA.spin = 1;
    retentionA.plannedDistance = 1000;
    retentionB.state = 'STOPPED';
    retentionB.x = 90;
    const retentionWorld = new PhysicsWorld(cfg);
    retentionWorld.stepLogicFrame([retentionA, retentionB]);
    near(retentionA.spin, cfg.collisionSpinRetention, 1e-9,
        'one effective collision must retain curve amplitude exactly once');

    const ccdA = new DiscModel('R1', 'RED', 0, cfg.discRadius);
    const ccdB = new DiscModel('B1', 'BLUE', 1, cfg.discRadius);
    ccdA.state = 'MOVING';
    ccdA.x = -200;
    ccdA.vx = 30000;
    ccdB.state = 'STOPPED';
    ccdB.x = 0;
    const ccdWorld = new PhysicsWorld(config({ tableLeftX: -1000, tableRightX: 1000 }));
    ccdWorld.stepLogicFrame([ccdA, ccdB]);
    assert(ccdWorld.currentTurnCollisionCount > 0, 'CCD must catch a disc crossed within one microstep');
    assert(Math.hypot(ccdA.x - ccdB.x, ccdA.y - ccdB.y) >= 89.5,
        'CCD must not leave a large overlap');

    const down = new DiscModel('R1', 'RED', 0, cfg.discRadius);
    down.state = 'MOVING';
    down.y = -1090;
    down.vy = -500;
    const downWorld = new PhysicsWorld(cfg);
    for (let frame = 0; frame < 300 && down.state === 'MOVING'; frame += 1) {
        downWorld.stepLogicFrame([down]);
    }
    assert(String(down.state) === 'STOPPED' && down.y < cfg.tableBottomY,
        'moving below the visual bottom must not become OUT');

    const top = new DiscModel('R1', 'RED', 0, cfg.discRadius);
    top.state = 'MOVING';
    top.y = 890;
    top.vy = 500;
    const topWorld = new PhysicsWorld(cfg);
    topWorld.stepLogicFrame([top]);
    topWorld.stepLogicFrame([top]);
    assert(String(top.state) === 'OUT', 'crossing top boundary must become OUT');

    const ignoredOld = new DiscModel('B1', 'BLUE', 1, cfg.discRadius);
    const ignoredNew = new DiscModel('R1', 'RED', 0, cfg.discRadius);
    ignoredOld.state = 'STOPPED';
    ignoredNew.state = 'AIMING';
    const ignoreWorld = new PhysicsWorld(config({ tableLeftX: -2000, tableRightX: 2000 }));
    ignoreWorld.createLaunchIgnorePairs(ignoredNew, [ignoredOld, ignoredNew]);
    ignoredNew.state = 'MOVING';
    ignoredNew.vx = 1000;
    for (let frame = 0; frame < 10 && ignoreWorld.launchIgnorePairs.size > 0; frame += 1) {
        ignoreWorld.stepLogicFrame([ignoredOld, ignoredNew]);
    }
    near(ignoredOld.x, 0, 0.001, 'launch overlap ignore must not push the old disc');
    assert(ignoreWorld.launchIgnorePairs.size === 0, 'launch ignore must be removed after separation');

    const match = new MatchController(cfg);
    const scoreDisc = match.discs[0];
    scoreDisc.state = 'STOPPED';
    const distances = [0, 110, 150, 200, 250, 300, 90];
    const expected = [5, 4, 3, 2, 1, 0, 4];
    distances.forEach((distance, index) => {
        scoreDisc.x = cfg.targetCenterX + distance;
        scoreDisc.y = cfg.targetCenterY;
        assert(match.scoreDisc(scoreDisc) === expected[index], `score case ${distance}`);
    });

    const fullMatch = new MatchController(cfg);
    const fullWorld = new PhysicsWorld(cfg);
    for (let turn = 0; turn < 8; turn += 1) {
        const current = fullMatch.currentDisc;
        assert(current?.id === ['R1', 'B1', 'R2', 'B2', 'R3', 'B3', 'R4', 'B4'][turn],
            `turn order ${turn}`);
        assert(fullMatch.beginAim(), `turn ${turn} must enter aiming`);
        if (!current) throw new Error('missing current disc');
        fullWorld.beginTurn();
        fullWorld.createLaunchIgnorePairs(current, fullMatch.discs);
        assert(fullMatch.commitLaunch(0, 50, 0), `turn ${turn} launch commit`);
        let safety = 0;
        while (fullMatch.state === 'TURN_SIMULATING' && safety < 120) {
            fullWorld.stepLogicFrame(fullMatch.discs);
            fullMatch.afterLogicFrame();
            safety += 1;
        }
        while (fullMatch.state === 'TURN_SETTLING' && safety < 180) {
            fullMatch.afterLogicFrame();
            safety += 1;
        }
        assert(safety < 180, `turn ${turn} must settle`);
    }
    assert(fullMatch.state === 'MATCH_RESULT' && fullMatch.turnIndex === 8,
        'exactly eight launches must enter one match result');
    fullWorld.reset();
    fullMatch.restart();
    assert(fullMatch.state === 'TURN_READY'
        && fullMatch.turnIndex === 0
        && fullMatch.currentDisc?.id === 'R1', 'restart must completely reset the match');

    console.log(JSON.stringify({
        status: 'PASS',
        straightStop: { x: straight.x, y: straight.y, time: straight.motionTime },
        placementStraightStopY: placementStraight.y,
        attackSpeedAtTarget,
        fullStraightState: fullStraight.state,
        curveAt065: { positiveSpinX: rightCurve.x, negativeSpinX: leftCurve.x },
        fixedReferenceCurveAt075: { x: attackCurve.x, y: attackCurve.y },
        ccdCollisions: ccdWorld.currentTurnCollisionCount,
    }, null, 2));
}

run();
