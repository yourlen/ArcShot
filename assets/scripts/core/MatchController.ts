import {
    ArcShotConfig,
    initialSpeedForPullRatio,
    LOGIC_DT,
    targetTravelDistance,
} from './ArcShotConfig';
import { Camp, createDefaultDiscs, DiscModel } from './DiscModel';
import {
    checkpointHash,
    cloneCheckpoint,
    createDiscCheckpoint,
    deriveCheckpointScores,
    deriveWinnerCode,
    validateCheckpoint,
} from '../shared/CheckpointCodec';
import { CheckpointDiscStateCode, CheckpointV1, ShotCommand } from '../shared/PvpTypes';

export type MatchState =
    | 'MATCH_SETUP'
    | 'TURN_READY'
    | 'TURN_AIMING'
    | 'TURN_SIMULATING'
    | 'TURN_SETTLING'
    | 'TURN_NETWORK_WAIT'
    | 'MATCH_RESULT';

export type GameMode = 'LOCAL_HOTSEAT' | 'LOCAL_WEB_PVP';

export class MatchController {
    public readonly discs: DiscModel[];
    public state: MatchState = 'MATCH_SETUP';
    public turnIndex = 0;
    public redScore = 0;
    public blueScore = 0;
    public winnerText = '';
    public settlingElapsed = 0;
    public settlingFrames = 0;
    public warnings: string[] = [];
    public gameMode: GameMode = 'LOCAL_HOTSEAT';

    private pendingCandidate: CheckpointV1 | null = null;

    public constructor(private readonly config: ArcShotConfig) {
        this.discs = createDefaultDiscs(config.discRadius);
        this.restart();
    }

    public get currentDisc(): DiscModel | null {
        return this.turnIndex >= 0 && this.turnIndex < this.discs.length
            ? this.discs[this.turnIndex]
            : null;
    }

    public get currentCamp(): Camp | null {
        return this.currentDisc?.camp ?? null;
    }

    public restart(): void {
        this.state = 'MATCH_SETUP';
        this.turnIndex = 0;
        this.redScore = 0;
        this.blueScore = 0;
        this.winnerText = '';
        this.settlingElapsed = 0;
        this.settlingFrames = 0;
        this.pendingCandidate = null;
        this.warnings.length = 0;
        for (const disc of this.discs) {
            disc.reset(this.config.discRadius);
        }
        this.loadCurrentDisc();
    }

    public setGameMode(mode: GameMode): void {
        if (this.gameMode === mode) return;
        this.gameMode = mode;
        this.restart();
    }

    public beginAim(): boolean {
        const disc = this.currentDisc;
        if (this.state !== 'TURN_READY' || !disc || disc.state !== 'READY') {
            return false;
        }
        disc.state = 'AIMING';
        this.state = 'TURN_AIMING';
        return true;
    }

    public cancelAim(): void {
        const disc = this.currentDisc;
        if (disc && disc.state === 'AIMING') {
            disc.state = 'READY';
        }
        if (this.turnIndex < this.discs.length) {
            this.state = 'TURN_READY';
        }
    }

    public commitLaunch(
        velocityX: number,
        velocityY: number,
        curveAmplitude: number,
        plannedDistance = 0,
    ): boolean {
        const disc = this.currentDisc;
        if (!disc || disc.state !== 'AIMING' || this.state !== 'TURN_AIMING') {
            return false;
        }
        disc.vx = velocityX;
        disc.vy = velocityY;
        for (const item of this.discs) {
            item.microstepTravelDistance = 0;
            item.actualTravelDistance = 0;
            item.correctionDistance = 0;
        }
        disc.spin = curveAmplitude;
        disc.capturedSpinRatio = curveAmplitude;
        disc.plannedDistance = plannedDistance;
        disc.curveProgress = 0;
        disc.freeTravelBudget = 0;
        disc.curveEnvelope = 0;
        disc.deltaProgress = 0;
        disc.deltaHeading = 0;
        const launchSpeed = Math.hypot(velocityX, velocityY);
        disc.launchDirectionX = launchSpeed > 0 ? velocityX / launchSpeed : 0;
        disc.launchDirectionY = launchSpeed > 0 ? velocityY / launchSpeed : 0;
        disc.launchStartX = disc.x;
        disc.launchStartY = disc.y;
        disc.trail.length = 0;
        disc.trail.push({ x: disc.x, y: disc.y });
        disc.motionTime = 0;
        disc.pathLength = 0;
        disc.collisionCount = 0;
        disc.state = 'MOVING';
        this.state = 'TURN_SIMULATING';
        return true;
    }

    /** 两种游戏模式唯一使用的规范发射入口。 */
    public applyCommittedShot(command: ShotCommand): boolean {
        const disc = this.currentDisc;
        if (!disc || (this.state !== 'TURN_READY' && this.state !== 'TURN_AIMING')) {
            return false;
        }
        const directionLength = Math.hypot(command.directionX, command.directionY);
        if (!(directionLength > 0)
            || !Number.isFinite(directionLength)
            || !(command.directionY > 0)
            || command.pullRatio < this.config.minimumFireRatio
            || command.pullRatio > 1
            || command.curveRatio < -1
            || command.curveRatio > 1) {
            return false;
        }
        if (disc.state === 'READY') disc.state = 'AIMING';
        this.state = 'TURN_AIMING';
        const directionX = command.directionX / directionLength;
        const directionY = command.directionY / directionLength;
        const initialSpeed = initialSpeedForPullRatio(this.config, command.pullRatio);
        return this.commitLaunch(
            directionX * initialSpeed,
            directionY * initialSpeed,
            command.curveRatio,
            targetTravelDistance(this.config, command.pullRatio),
        );
    }

    public afterLogicFrame(): void {
        if (this.state === 'TURN_SIMULATING') {
            if (!this.discs.some(disc => disc.state === 'MOVING')) {
                for (const disc of this.discs) {
                    if (disc.state === 'STOPPED' && Math.abs(disc.spin) > 0) {
                        disc.spin = 0;
                        this.warnings.push('RESIDUAL_SPIN_CLEARED');
                    }
                }
                this.state = 'TURN_SETTLING';
                this.settlingElapsed = 0;
                this.settlingFrames = 0;
            }
            return;
        }

        if (this.state !== 'TURN_SETTLING') {
            return;
        }
        this.settlingElapsed += LOGIC_DT;
        this.settlingFrames += 1;
        const requiredFrames = Math.round(this.config.settlingTime / LOGIC_DT);
        if (this.settlingFrames < requiredFrames) {
            return;
        }

        if (this.gameMode === 'LOCAL_WEB_PVP') {
            this.pendingCandidate = this.buildCandidateCheckpoint(this.turnIndex);
            this.state = 'TURN_NETWORK_WAIT';
            return;
        }

        this.recalculateScores();
        this.turnIndex += 1;
        this.settlingElapsed = 0;
        this.settlingFrames = 0;
        if (this.turnIndex >= this.discs.length) {
            this.state = 'MATCH_RESULT';
            this.winnerText = this.redScore === this.blueScore
                ? '平局'
                : this.redScore > this.blueScore
                    ? '红方胜'
                    : '蓝方胜';
            return;
        }
        this.loadCurrentDisc();
    }

    public buildCandidateCheckpoint(completedTurnIndex: number): CheckpointV1 {
        if (completedTurnIndex !== this.turnIndex || completedTurnIndex < 0 || completedTurnIndex > 7) {
            throw new Error('INVALID_COMPLETED_TURN');
        }
        if (this.discs.some(disc => disc.state === 'MOVING' || disc.state === 'AIMING')) {
            throw new Error('CANDIDATE_WHILE_ACTIVE');
        }
        const nextTurnIndex = completedTurnIndex + 1;
        const discs = this.discs.map((disc, index) => {
            if (index < nextTurnIndex) {
                return createDiscCheckpoint(index, this.checkpointStateCode(disc), disc.x, disc.y);
            }
            if (index === nextTurnIndex && nextTurnIndex < 8) {
                return createDiscCheckpoint(
                    index,
                    1,
                    0,
                    this.config.fireLineY - this.config.discRadius,
                );
            }
            return createDiscCheckpoint(index, 0, 0, 0);
        });
        const scores = deriveCheckpointScores(discs);
        const finished = nextTurnIndex === 8;
        const checkpoint: CheckpointV1 = {
            schemaVersion: 1,
            phaseCode: finished ? 1 : 0,
            turnIndex: nextTurnIndex,
            redScore: scores.redScore,
            blueScore: scores.blueScore,
            winnerCode: deriveWinnerCode(scores.redScore, scores.blueScore, finished),
            discs,
        };
        const errors = validateCheckpoint(checkpoint);
        if (errors.length > 0) throw new Error(`CANDIDATE_INVALID:${errors.join(',')}`);
        return checkpoint;
    }

    public getPendingCandidate(): CheckpointV1 | null {
        return this.pendingCandidate ? cloneCheckpoint(this.pendingCandidate) : null;
    }

    public loadCheckpoint(checkpoint: CheckpointV1): string {
        const errors = validateCheckpoint(checkpoint);
        if (errors.length > 0) throw new Error(`SNAPSHOT_INVALID:${errors.join(',')}`);
        this.pendingCandidate = null;
        this.turnIndex = checkpoint.turnIndex;
        this.redScore = checkpoint.redScore;
        this.blueScore = checkpoint.blueScore;
        this.settlingElapsed = 0;
        this.settlingFrames = 0;
        this.warnings.length = 0;
        for (let index = 0; index < this.discs.length; index += 1) {
            const model = this.discs[index];
            const source = checkpoint.discs.find(disc => disc.idCode === index);
            if (!source) throw new Error(`SNAPSHOT_DISC_MISSING:${index}`);
            model.reset(this.config.discRadius);
            model.state = source.stateCode === 0
                ? 'UNUSED'
                : source.stateCode === 1
                    ? 'READY'
                    : source.stateCode === 2
                        ? 'STOPPED'
                        : 'OUT';
            model.x = source.xQ / 1000;
            model.y = source.yQ / 1000;
        }
        if (checkpoint.turnIndex === 8) {
            this.state = 'MATCH_RESULT';
            this.winnerText = checkpoint.winnerCode === 3
                ? '平局'
                : checkpoint.winnerCode === 1
                    ? '红方胜'
                    : '蓝方胜';
        } else {
            this.state = 'TURN_READY';
            this.winnerText = '';
        }
        return checkpointHash(checkpoint);
    }

    public recalculateScores(): void {
        let red = 0;
        let blue = 0;
        for (const disc of this.discs) {
            if (disc.state !== 'STOPPED') {
                continue;
            }
            const score = this.scoreDisc(disc);
            if (disc.camp === 'RED') red += score;
            else blue += score;
        }
        this.redScore = red;
        this.blueScore = blue;
    }

    public scoreDisc(disc: DiscModel): number {
        const distance = Math.hypot(
            disc.x - this.config.targetCenterX,
            disc.y - this.config.targetCenterY,
        );
        for (let index = 0; index < this.config.scoreRingRadii.length; index += 1) {
            if (distance < this.config.scoreRingRadii[index] + disc.radius) {
                return this.config.scoreValues[index] ?? 0;
            }
        }
        return 0;
    }

    public unlaunchedCount(camp: Camp): number {
        return this.discs.filter(disc => disc.camp === camp && (
            disc.state === 'UNUSED'
            || disc.state === 'READY'
            || disc.state === 'AIMING'
        )).length;
    }

    private loadCurrentDisc(): void {
        const disc = this.currentDisc;
        if (!disc) {
            return;
        }
        disc.state = 'READY';
        disc.x = 0;
        disc.y = this.config.fireLineY - disc.radius;
        disc.vx = 0;
        disc.vy = 0;
        disc.spin = 0;
        disc.capturedSpinRatio = 0;
        disc.plannedDistance = 0;
        disc.curveProgress = 0;
        disc.freeTravelBudget = 0;
        disc.curveEnvelope = 0;
        disc.deltaProgress = 0;
        disc.deltaHeading = 0;
        this.state = 'TURN_READY';
    }

    private checkpointStateCode(disc: DiscModel): CheckpointDiscStateCode {
        if (disc.state === 'STOPPED') return 2;
        if (disc.state === 'OUT') return 3;
        throw new Error(`DISC_NOT_SETTLED:${disc.id}:${disc.state}`);
    }
}
