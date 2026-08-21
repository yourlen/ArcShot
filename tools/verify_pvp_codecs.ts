import { checkpointHash, cloneCheckpoint, validateCheckpoint } from '../assets/scripts/shared/CheckpointCodec';
import { fnv1aAscii, roundAway } from '../assets/scripts/shared/CanonicalMath';
import {
    INITIAL_CHECKPOINT,
    RULESET_MANIFEST,
    canonicalRulesetManifest,
    verifyRulesetManifest,
} from '../assets/scripts/shared/RulesetManifest';
import {
    dequantizeShotCommand,
    quantizeShotCommand,
    validateShotCommandQ,
} from '../assets/scripts/shared/ShotCommandCodec';
import { CheckpointV1 } from '../assets/scripts/shared/PvpTypes';

function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
}

assert(roundAway(0.5) === 1, 'roundAway positive half');
assert(roundAway(-0.5) === -1, 'roundAway negative half');
assert(checkpointHash(INITIAL_CHECKPOINT) === 'dba54029', 'initial checkpoint vector');
assert(fnv1aAscii(canonicalRulesetManifest()) === 'e98b3f53', 'manifest vector');
assert(verifyRulesetManifest().length === 0, 'manifest verification');
assert(validateCheckpoint(INITIAL_CHECKPOINT).length === 0, 'initial checkpoint validation');

const finalCheckpoint: CheckpointV1 = {
    schemaVersion: 1,
    phaseCode: 1,
    turnIndex: 8,
    redScore: 5,
    blueScore: 0,
    winnerCode: 1,
    discs: [
        { idCode: 0, stateCode: 2, xQ: 0, yQ: 590000 },
        { idCode: 1, stateCode: 3, xQ: 0, yQ: 0 },
        { idCode: 2, stateCode: 3, xQ: 0, yQ: 0 },
        { idCode: 3, stateCode: 3, xQ: 0, yQ: 0 },
        { idCode: 4, stateCode: 3, xQ: 0, yQ: 0 },
        { idCode: 5, stateCode: 3, xQ: 0, yQ: 0 },
        { idCode: 6, stateCode: 3, xQ: 0, yQ: 0 },
        { idCode: 7, stateCode: 3, xQ: 0, yQ: 0 },
    ],
};
assert(checkpointHash(finalCheckpoint) === '69e6e094', 'final checkpoint vector');
assert(validateCheckpoint(finalCheckpoint).length === 0, 'final checkpoint validation');

const tampered = cloneCheckpoint(INITIAL_CHECKPOINT);
tampered.discs[0].xQ += 1000;
assert(checkpointHash(tampered) !== checkpointHash(INITIAL_CHECKPOINT), 'tamper changes hash');

const shotQ = quantizeShotCommand({
    directionX: 0.6,
    directionY: 0.8,
    pullRatio: 0.75,
    curveRatio: -1,
});
assert(validateShotCommandQ(shotQ).length === 0, 'shot command validates');
const shot = dequantizeShotCommand(shotQ);
assert(Math.abs(shot.directionX - 0.6) < 1e-6, 'shot direction x');
assert(Math.abs(shot.directionY - 0.8) < 1e-6, 'shot direction y');
assert(shot.pullRatio === 0.75 && shot.curveRatio === -1, 'shot ratios');

console.log(JSON.stringify({
    status: 'PASS',
    protocolVersion: RULESET_MANIFEST.protocolVersion,
    rulesetVersion: RULESET_MANIFEST.rulesetVersion,
    initialHash: checkpointHash(INITIAL_CHECKPOINT),
    finalHash: checkpointHash(finalCheckpoint),
    manifestHash: fnv1aAscii(canonicalRulesetManifest()),
    shotQ,
}, null, 2));
