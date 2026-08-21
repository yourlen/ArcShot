export type Camp = 'RED' | 'BLUE';
export type DiscState = 'UNUSED' | 'READY' | 'AIMING' | 'MOVING' | 'STOPPED' | 'OUT';

export interface Vec2Data {
    x: number;
    y: number;
}

export class DiscModel {
    public state: DiscState = 'UNUSED';
    public x = 0;
    public y = 0;
    public vx = 0;
    public vy = 0;
    public spin = 0;
    public motionTime = 0;
    public pathLength = 0;
    public collisionCount = 0;
    public launchDirectionX = 0;
    public launchDirectionY = 0;
    public launchStartX = 0;
    public launchStartY = 0;
    public plannedDistance = 0;
    public curveProgress = 0;
    public freeTravelBudget = 0;
    public curveEnvelope = 0;
    public deltaProgress = 0;
    public deltaHeading = 0;
    public capturedSpinRatio = 0;
    public microstepTravelDistance = 0;
    public actualTravelDistance = 0;
    public correctionDistance = 0;
    public readonly trail: Vec2Data[] = [];

    public constructor(
        public readonly id: string,
        public readonly camp: Camp,
        public readonly order: number,
        public radius: number,
    ) {}

    public get speed(): number {
        return Math.hypot(this.vx, this.vy);
    }

    public reset(radius: number): void {
        this.radius = radius;
        this.state = 'UNUSED';
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        this.spin = 0;
        this.motionTime = 0;
        this.pathLength = 0;
        this.collisionCount = 0;
        this.launchDirectionX = 0;
        this.launchDirectionY = 0;
        this.launchStartX = 0;
        this.launchStartY = 0;
        this.plannedDistance = 0;
        this.curveProgress = 0;
        this.freeTravelBudget = 0;
        this.curveEnvelope = 0;
        this.deltaProgress = 0;
        this.deltaHeading = 0;
        this.capturedSpinRatio = 0;
        this.microstepTravelDistance = 0;
        this.actualTravelDistance = 0;
        this.correctionDistance = 0;
        this.trail.length = 0;
    }

    public stop(): void {
        this.vx = 0;
        this.vy = 0;
        this.spin = 0;
        if (this.state !== 'OUT') {
            this.state = 'STOPPED';
        }
    }

    public markOut(): void {
        this.vx = 0;
        this.vy = 0;
        this.spin = 0;
        this.state = 'OUT';
    }
}

export function createDefaultDiscs(radius: number): DiscModel[] {
    const ids: Array<[string, Camp]> = [
        ['R1', 'RED'],
        ['B1', 'BLUE'],
        ['R2', 'RED'],
        ['B2', 'BLUE'],
        ['R3', 'RED'],
        ['B3', 'BLUE'],
        ['R4', 'RED'],
        ['B4', 'BLUE'],
    ];
    return ids.map(([id, camp], order) => new DiscModel(id, camp, order, radius));
}

export function pairKey(a: DiscModel, b: DiscModel): string {
    return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}
