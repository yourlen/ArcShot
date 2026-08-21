import {
    ArcShotConfig,
    curveEnvelope,
    EVENT_SIMULTANEOUS_TOLERANCE,
    MICRO_DT,
    MICRO_STEPS_PER_LOGIC_FRAME,
} from './ArcShotConfig';
import { DiscModel, pairKey } from './DiscModel';

type Boundary = 'LEFT' | 'RIGHT' | 'TOP';

interface CollisionCandidate {
    type: 'COLLISION';
    time: number;
    a: DiscModel;
    b: DiscModel;
}

interface BoundaryCandidate {
    type: 'BOUNDARY';
    time: number;
    disc: DiscModel;
    boundary: Boundary;
}

type PhysicsCandidate = CollisionCandidate | BoundaryCandidate;

const EPSILON = 1e-9;

export class PhysicsWorld {
    public readonly launchIgnorePairs = new Set<string>();
    public readonly errors: string[] = [];
    public currentTurnCollisionCount = 0;
    public lastMicrostepEventCount = 0;

    public constructor(private readonly config: ArcShotConfig) {}

    public reset(): void {
        this.launchIgnorePairs.clear();
        this.errors.length = 0;
        this.currentTurnCollisionCount = 0;
        this.lastMicrostepEventCount = 0;
    }

    public beginTurn(): void {
        this.currentTurnCollisionCount = 0;
    }

    public createLaunchIgnorePairs(newDisc: DiscModel, discs: DiscModel[]): void {
        for (const other of discs) {
            if (other === newDisc || !isCollisionParticipant(other)) {
                continue;
            }
            const distance = Math.hypot(newDisc.x - other.x, newDisc.y - other.y);
            if (distance < newDisc.radius + other.radius) {
                this.launchIgnorePairs.add(pairKey(newDisc, other));
            }
        }
    }

    public stepLogicFrame(discs: DiscModel[]): void {
        for (let index = 0; index < MICRO_STEPS_PER_LOGIC_FRAME; index += 1) {
            this.stepMicro(discs);
        }
        for (const disc of discs) {
            this.recordTrailPoint(disc);
        }
    }

    private recordTrailPoint(disc: DiscModel): void {
        if (disc.trail.length === 0) {
            if (disc.motionTime > 0 || disc.pathLength > 0) disc.trail.push({ x: disc.x, y: disc.y });
            return;
        }
        const last = disc.trail[disc.trail.length - 1];
        const distance = Math.hypot(disc.x - last.x, disc.y - last.y);
        if (distance < 4 && disc.state === 'MOVING') return;
        disc.trail.push({ x: disc.x, y: disc.y });
        if (disc.trail.length > 600) disc.trail.splice(0, disc.trail.length - 600);
    }

    private stepMicro(discs: DiscModel[]): void {
        this.lastMicrostepEventCount = 0;
        for (const disc of discs) {
            disc.microstepTravelDistance = 0;
            if (disc.state === 'MOVING') {
                this.applyCurveAndFriction(disc, MICRO_DT);
            }
        }

        try {
            let remainingTime = MICRO_DT;
            let eventCount = 0;
            while (remainingTime > EPSILON) {
                if (!this.correctPositions(discs)) {
                    return;
                }
                this.markStrictlyOutsideDiscs(discs);

                const candidates = this.findCandidates(discs, remainingTime);
                if (candidates.length === 0) {
                    this.advanceAll(discs, remainingTime);
                    this.removeSeparatedLaunchIgnores(discs);
                    remainingTime = 0;
                    break;
                }

                candidates.sort(compareCandidates);
                const firstTime = clamp(candidates[0].time, 0, remainingTime);
                const group = candidates.filter(candidate => (
                    candidate.time <= candidates[0].time + EVENT_SIMULTANEOUS_TOLERANCE
                ));

                if (firstTime > 0) {
                    this.advanceAll(discs, firstTime);
                    remainingTime -= firstTime;
                }
                this.removeSeparatedLaunchIgnores(discs);

                const collisions = group
                    .filter((candidate): candidate is CollisionCandidate => candidate.type === 'COLLISION')
                    .sort((left, right) => pairKey(left.a, left.b).localeCompare(pairKey(right.a, right.b)));
                for (const collision of collisions) {
                    eventCount += 1;
                    if (eventCount > this.config.maxCollisionEventsPerMicrostep) {
                        this.failSafe(discs, 'PHYSICS_EVENT_LIMIT');
                        return;
                    }
                    this.resolveCollision(collision.a, collision.b);
                }

                const boundaries = group
                    .filter((candidate): candidate is BoundaryCandidate => candidate.type === 'BOUNDARY')
                    .sort((left, right) => {
                        const byId = left.disc.id.localeCompare(right.disc.id);
                        return byId !== 0 ? byId : left.boundary.localeCompare(right.boundary);
                    });
                for (const boundary of boundaries) {
                    this.resolveBoundaryEvent(boundary);
                }

                this.lastMicrostepEventCount = eventCount;
                if (firstTime <= EPSILON && collisions.length === 0 && boundaries.length === 0) {
                    break;
                }
            }

            for (const disc of discs) {
                if (disc.state !== 'MOVING') {
                    continue;
                }
                if (disc.speed <= this.config.stopSpeed + EPSILON) {
                    disc.stop();
                }
            }
        } finally {
            for (const disc of discs) {
                disc.actualTravelDistance += disc.microstepTravelDistance;
            }
        }
    }

    private applyCurveAndFriction(disc: DiscModel, deltaTime: number): void {
        const speedBefore = disc.speed;
        disc.freeTravelBudget = 0;
        disc.deltaProgress = 0;
        disc.deltaHeading = 0;
        disc.curveEnvelope = curveEnvelope(this.config, disc.curveProgress);
        if (speedBefore <= this.config.stopSpeed + EPSILON) {
            disc.stop();
            return;
        }

        const speedAfterFriction = Math.max(
            0,
            speedBefore - this.config.linearDeceleration * deltaTime,
        );
        disc.freeTravelBudget = speedAfterFriction * deltaTime;

        const u0 = disc.curveProgress;
        const u1 = this.config.curveReferenceDistance > 0 && u0 < 1
            ? clamp(u0 + disc.freeTravelBudget / this.config.curveReferenceDistance, 0, 1)
            : u0;
        const deltaProgress = u1 - u0;
        const midpointProgress = (u0 + u1) * 0.5;
        const envelope = curveEnvelope(this.config, midpointProgress);
        const maxHeadingRadians = this.config.maxCurveHeadingDegrees * Math.PI / 180;
        const deltaHeading = deltaProgress > 0
            ? disc.spin
                * maxHeadingRadians
                * envelope
                / this.config.curveEnvelopeArea
                * deltaProgress
            : 0;

        if (Math.abs(deltaHeading) > EPSILON) {
            // 正弧线倍率向当前速度的右侧转动；只旋转方向，不改变速度大小。
            const cosine = Math.cos(deltaHeading);
            const sine = Math.sin(deltaHeading);
            const rotatedX = disc.vx * cosine + disc.vy * sine;
            const rotatedY = -disc.vx * sine + disc.vy * cosine;
            disc.vx = rotatedX;
            disc.vy = rotatedY;
        }

        const scale = speedBefore > EPSILON ? speedAfterFriction / speedBefore : 0;
        disc.vx *= scale;
        disc.vy *= scale;
        disc.curveProgress = u1;
        disc.deltaProgress = deltaProgress;
        disc.curveEnvelope = envelope;
        disc.deltaHeading = deltaHeading;
    }

    private findCandidates(discs: DiscModel[], remainingTime: number): PhysicsCandidate[] {
        const candidates: PhysicsCandidate[] = [];
        const participants = discs
            .filter(isCollisionParticipant)
            .sort((a, b) => a.id.localeCompare(b.id));

        for (let aIndex = 0; aIndex < participants.length; aIndex += 1) {
            const a = participants[aIndex];
            for (let bIndex = aIndex + 1; bIndex < participants.length; bIndex += 1) {
                const b = participants[bIndex];
                if (this.launchIgnorePairs.has(pairKey(a, b))) {
                    continue;
                }
                const time = this.collisionTime(a, b, remainingTime);
                if (time !== null) {
                    candidates.push({ type: 'COLLISION', time, a, b });
                }
            }
        }

        for (const disc of discs) {
            if (disc.state !== 'MOVING') {
                continue;
            }
            if (disc.vx < -EPSILON) {
                const time = (this.config.tableLeftX - disc.x) / disc.vx;
                if (isTimeInRange(time, remainingTime)) {
                    candidates.push({ type: 'BOUNDARY', time: Math.max(0, time), disc, boundary: 'LEFT' });
                }
            }
            if (disc.vx > EPSILON) {
                const time = (this.config.tableRightX - disc.x) / disc.vx;
                if (isTimeInRange(time, remainingTime)) {
                    candidates.push({ type: 'BOUNDARY', time: Math.max(0, time), disc, boundary: 'RIGHT' });
                }
            }
            if (disc.vy > EPSILON) {
                const time = (this.config.tableTopY - disc.y) / disc.vy;
                if (isTimeInRange(time, remainingTime)) {
                    candidates.push({ type: 'BOUNDARY', time: Math.max(0, time), disc, boundary: 'TOP' });
                }
            }
        }
        return candidates;
    }

    private collisionTime(a: DiscModel, b: DiscModel, remainingTime: number): number | null {
        const px = a.x - b.x;
        const py = a.y - b.y;
        const vx = a.vx - b.vx;
        const vy = a.vy - b.vy;
        const radius = a.radius + b.radius;
        const coefficientA = vx * vx + vy * vy;
        if (coefficientA <= EPSILON) {
            return null;
        }

        const coefficientB = 2 * (px * vx + py * vy);
        const coefficientC = px * px + py * py - radius * radius;
        if (coefficientC < 0) {
            return this.areApproaching(a, b) ? 0 : null;
        }

        const discriminant = coefficientB * coefficientB
            - 4 * coefficientA * coefficientC;
        if (discriminant < 0) {
            return null;
        }
        const root = Math.sqrt(Math.max(0, discriminant));
        const roots = [
            (-coefficientB - root) / (2 * coefficientA),
            (-coefficientB + root) / (2 * coefficientA),
        ].sort((left, right) => left - right);

        for (const rawTime of roots) {
            if (!isTimeInRange(rawTime, remainingTime)) {
                continue;
            }
            const time = Math.max(0, rawTime);
            if (this.areApproachingAtTime(a, b, time)) {
                return time;
            }
        }
        return null;
    }

    private resolveCollision(a: DiscModel, b: DiscModel): void {
        if (!isCollisionParticipant(a)
            || !isCollisionParticipant(b)
            || this.launchIgnorePairs.has(pairKey(a, b))) {
            return;
        }
        const normal = collisionNormal(a, b);
        const approachSpeed = (a.vx - b.vx) * normal.x
            + (a.vy - b.vy) * normal.y;
        if (approachSpeed <= EPSILON) {
            return;
        }

        const result = resolveEqualMassCollision(
            a.vx,
            a.vy,
            b.vx,
            b.vy,
            normal.x,
            normal.y,
            this.config.collisionRestitution,
        );
        a.vx = result.aVx;
        a.vy = result.aVy;
        b.vx = result.bVx;
        b.vy = result.bVy;
        a.spin *= this.config.collisionSpinRetention;
        b.spin *= this.config.collisionSpinRetention;
        a.collisionCount += 1;
        b.collisionCount += 1;
        this.currentTurnCollisionCount += 1;
        this.applyPostCollisionState(a);
        this.applyPostCollisionState(b);
    }

    private applyPostCollisionState(disc: DiscModel): void {
        if (disc.state === 'OUT') {
            return;
        }
        if (disc.speed > this.config.stopSpeed) {
            disc.state = 'MOVING';
        } else {
            disc.stop();
        }
    }

    private resolveBoundaryEvent(candidate: BoundaryCandidate): void {
        const disc = candidate.disc;
        if (disc.state !== 'MOVING') {
            return;
        }
        let movingOutward = false;
        if (candidate.boundary === 'LEFT') {
            disc.x = this.config.tableLeftX;
            movingOutward = disc.vx < 0;
        } else if (candidate.boundary === 'RIGHT') {
            disc.x = this.config.tableRightX;
            movingOutward = disc.vx > 0;
        } else {
            disc.y = this.config.tableTopY;
            movingOutward = disc.vy > 0;
        }
        if (movingOutward) {
            this.markOut(disc);
        }
    }

    private advanceAll(discs: DiscModel[], deltaTime: number): void {
        for (const disc of discs) {
            if (disc.state !== 'MOVING') {
                continue;
            }
            const speed = disc.speed;
            disc.x += disc.vx * deltaTime;
            disc.y += disc.vy * deltaTime;
            disc.motionTime += deltaTime;
            const segmentDistance = speed * deltaTime;
            disc.pathLength += segmentDistance;
            disc.microstepTravelDistance += segmentDistance;
        }
    }

    private correctPositions(discs: DiscModel[]): boolean {
        const ordered = discs
            .filter(isCollisionParticipant)
            .sort((a, b) => a.id.localeCompare(b.id));
        for (let iteration = 0; iteration < this.config.maxPositionIterations; iteration += 1) {
            let corrected = false;
            for (let aIndex = 0; aIndex < ordered.length; aIndex += 1) {
                const a = ordered[aIndex];
                if (!isCollisionParticipant(a)) continue;
                for (let bIndex = aIndex + 1; bIndex < ordered.length; bIndex += 1) {
                    if (!isCollisionParticipant(a)) break;
                    const b = ordered[bIndex];
                    if (!isCollisionParticipant(b) || this.launchIgnorePairs.has(pairKey(a, b))) {
                        continue;
                    }
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const distance = Math.hypot(dx, dy);
                    const depth = a.radius + b.radius - distance;
                    if (depth <= this.config.positionSlop) {
                        continue;
                    }
                    const normal = collisionNormal(a, b);
                    const correction = depth * 0.5;
                    a.x -= normal.x * correction;
                    a.y -= normal.y * correction;
                    b.x += normal.x * correction;
                    b.y += normal.y * correction;
                    a.correctionDistance += correction;
                    b.correctionDistance += correction;
                    this.markIfStrictlyOutside(a);
                    this.markIfStrictlyOutside(b);
                    corrected = true;
                }
            }
            if (!corrected) {
                return true;
            }
        }

        if (this.hasExcessOverlap(discs)) {
            this.failSafe(discs, 'PHYSICS_POSITION_LIMIT');
            return false;
        }
        return true;
    }

    private hasExcessOverlap(discs: DiscModel[]): boolean {
        const participants = discs.filter(isCollisionParticipant);
        for (let aIndex = 0; aIndex < participants.length; aIndex += 1) {
            for (let bIndex = aIndex + 1; bIndex < participants.length; bIndex += 1) {
                const a = participants[aIndex];
                const b = participants[bIndex];
                if (this.launchIgnorePairs.has(pairKey(a, b))) continue;
                const depth = a.radius + b.radius - Math.hypot(a.x - b.x, a.y - b.y);
                if (depth > this.config.positionSlop) return true;
            }
        }
        return false;
    }

    private removeSeparatedLaunchIgnores(discs: DiscModel[]): void {
        const byId = new Map(discs.map(disc => [disc.id, disc]));
        // Cocos 的 release 构建会把 Set 展开错误地降级成 [].concat(set)，
        // 得到的是 Set 对象本身而不是其中的字符串。显式 Array.from 可避免
        // 首次发射后在 key.split() 处持续报错。
        for (const key of Array.from(this.launchIgnorePairs)) {
            const [aId, bId] = key.split('|');
            const a = byId.get(aId);
            const b = byId.get(bId);
            if (!a || !b || a.state === 'OUT' || b.state === 'OUT') {
                this.launchIgnorePairs.delete(key);
                continue;
            }
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            if (distance >= a.radius + b.radius) {
                this.launchIgnorePairs.delete(key);
            }
        }
    }

    private markStrictlyOutsideDiscs(discs: DiscModel[]): void {
        for (const disc of discs) {
            this.markIfStrictlyOutside(disc);
        }
    }

    private markIfStrictlyOutside(disc: DiscModel): void {
        if (!isCollisionParticipant(disc)) {
            return;
        }
        if (
            disc.x < this.config.tableLeftX
            || disc.x > this.config.tableRightX
            || disc.y > this.config.tableTopY
        ) {
            this.markOut(disc);
        }
    }

    private markOut(disc: DiscModel): void {
        disc.markOut();
        for (const key of Array.from(this.launchIgnorePairs)) {
            if (key.startsWith(`${disc.id}|`) || key.endsWith(`|${disc.id}`)) {
                this.launchIgnorePairs.delete(key);
            }
        }
    }

    private failSafe(discs: DiscModel[], code: string): void {
        this.errors.push(code);
        for (const disc of discs) {
            if (disc.state === 'MOVING') {
                disc.stop();
            }
        }
        this.lastMicrostepEventCount = this.config.maxCollisionEventsPerMicrostep;
    }

    private areApproaching(a: DiscModel, b: DiscModel): boolean {
        const normal = collisionNormal(a, b);
        return (a.vx - b.vx) * normal.x + (a.vy - b.vy) * normal.y > EPSILON;
    }

    private areApproachingAtTime(a: DiscModel, b: DiscModel, time: number): boolean {
        const futureA = { x: a.x + a.vx * time, y: a.y + a.vy * time };
        const futureB = { x: b.x + b.vx * time, y: b.y + b.vy * time };
        const dx = futureB.x - futureA.x;
        const dy = futureB.y - futureA.y;
        const length = Math.hypot(dx, dy);
        const normalX = length > EPSILON ? dx / length : (a.id < b.id ? 1 : -1);
        const normalY = length > EPSILON ? dy / length : 0;
        return (a.vx - b.vx) * normalX + (a.vy - b.vy) * normalY > EPSILON;
    }
}

function isCollisionParticipant(disc: DiscModel): boolean {
    return disc.state === 'MOVING' || disc.state === 'STOPPED';
}

function collisionNormal(a: DiscModel, b: DiscModel): { x: number; y: number } {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length > EPSILON) {
        return { x: dx / length, y: dy / length };
    }
    return { x: a.id < b.id ? 1 : -1, y: 0 };
}

function isTimeInRange(time: number, remainingTime: number): boolean {
    return Number.isFinite(time)
        && time >= -EVENT_SIMULTANEOUS_TOLERANCE
        && time <= remainingTime + EVENT_SIMULTANEOUS_TOLERANCE;
}

function compareCandidates(left: PhysicsCandidate, right: PhysicsCandidate): number {
    if (left.time !== right.time) return left.time - right.time;
    if (left.type !== right.type) return left.type === 'COLLISION' ? -1 : 1;
    if (left.type === 'COLLISION' && right.type === 'COLLISION') {
        return pairKey(left.a, left.b).localeCompare(pairKey(right.a, right.b));
    }
    if (left.type === 'BOUNDARY' && right.type === 'BOUNDARY') {
        return left.disc.id.localeCompare(right.disc.id)
            || left.boundary.localeCompare(right.boundary);
    }
    return 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolveEqualMassCollision(
    aVx: number,
    aVy: number,
    bVx: number,
    bVy: number,
    normalX: number,
    normalY: number,
    restitution: number,
): { aVx: number; aVy: number; bVx: number; bVy: number } {
    const approachSpeed = (aVx - bVx) * normalX + (aVy - bVy) * normalY;
    if (approachSpeed <= 0) {
        return { aVx, aVy, bVx, bVy };
    }
    const exchange = (1 + restitution) * approachSpeed * 0.5;
    return {
        aVx: aVx - normalX * exchange,
        aVy: aVy - normalY * exchange,
        bVx: bVx + normalX * exchange,
        bVy: bVy + normalY * exchange,
    };
}
