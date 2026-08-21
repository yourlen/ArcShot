import {
    ArcShotConfig,
    initialSpeedForPullRatio,
    targetTravelDistance,
} from './ArcShotConfig';
import { DiscModel } from './DiscModel';
import { MatchController } from './MatchController';

export interface LaunchSnapshot {
    directionX: number;
    directionY: number;
    pullRatio: number;
    targetTravelDistance: number;
    initialSpeed: number;
    spinRatio: number;
    initialSpin: number;
}

export class AimController {
    public activeTouchId = -1;
    public pointerX = 0;
    public pointerY = 0;
    public pullX = 0;
    public pullY = 0;
    public pullRatio = 0;
    public initialSpeedPreview = 0;
    public sliderRatio = 0;
    public sliderDirection = 1;

    private grabOffsetX = 0;
    private grabOffsetY = 0;
    private touchStartY = 0;
    private lockedLaunchX = 0;
    private lockedLaunchY = 0;

    public tryBeginTouch(
        touchId: number,
        pointX: number,
        pointY: number,
        disc: DiscModel | null,
    ): boolean {
        if (this.activeTouchId >= 0 || !disc || disc.state !== 'READY') {
            return false;
        }
        const dx = pointX - disc.x;
        const dy = pointY - disc.y;
        if (dx * dx + dy * dy > disc.radius * disc.radius) {
            return false;
        }

        this.activeTouchId = touchId;
        this.grabOffsetX = dx;
        this.grabOffsetY = dy;
        this.touchStartY = pointY;
        this.pointerX = pointX - this.grabOffsetX;
        this.pointerY = pointY - this.grabOffsetY;
        this.clearPreview();
        return true;
    }

    public moveTouch(
        touchId: number,
        pointX: number,
        pointY: number,
        disc: DiscModel | null,
        match: MatchController,
        config: ArcShotConfig,
    ): void {
        if (touchId !== this.activeTouchId || !disc) {
            return;
        }
        this.pointerX = pointX - this.grabOffsetX;
        this.pointerY = pointY - this.grabOffsetY;

        if (disc.state === 'READY') {
            if (config.allowLaunchPointDrag) {
                disc.x = clamp(
                    this.pointerX,
                    config.tableLeftX + disc.radius,
                    config.tableRightX - disc.radius,
                );
            }
            disc.y = config.fireLineY - disc.radius;
            if (this.touchStartY - pointY >= config.aimActivationDistance) {
                this.lockedLaunchX = disc.x;
                this.lockedLaunchY = disc.y;
                if (match.beginAim()) {
                    // 从中心起步：快速松手保持直线，约半个单程时间到达最大弧线。
                    // 之前从 -1 起步时，常见的 0.3 秒拖拽恰好落在 0，容易让玩家误以为弧线失效。
                    this.sliderRatio = 0;
                    this.sliderDirection = 1;
                    this.updatePreview(config);
                }
            }
            return;
        }

        if (disc.state === 'AIMING') {
            this.updatePreview(config);
            if (this.pullY >= 0) {
                this.returnAimToReadyKeepingTouch(pointX, pointY, disc, match);
            }
        }
    }

    public updateSlider(deltaTime: number, disc: DiscModel | null, config: ArcShotConfig): void {
        if (!disc || disc.state !== 'AIMING') {
            return;
        }
        const speed = 2 / Math.max(0.001, config.spinSliderOneWayTime);
        this.sliderRatio += this.sliderDirection * speed * Math.max(0, deltaTime);
        while (this.sliderRatio > 1 || this.sliderRatio < -1) {
            if (this.sliderRatio > 1) {
                this.sliderRatio = 2 - this.sliderRatio;
                this.sliderDirection = -1;
            } else if (this.sliderRatio < -1) {
                this.sliderRatio = -2 - this.sliderRatio;
                this.sliderDirection = 1;
            }
        }
    }

    public releaseTouch(
        touchId: number,
        pointX: number,
        pointY: number,
        disc: DiscModel | null,
        match: MatchController,
        config: ArcShotConfig,
        renderedSliderRatio?: number,
    ): LaunchSnapshot | null {
        if (touchId !== this.activeTouchId || !disc) {
            return null;
        }
        this.pointerX = pointX - this.grabOffsetX;
        this.pointerY = pointY - this.grabOffsetY;

        if (disc.state !== 'AIMING') {
            this.cancel(match);
            return null;
        }
        this.updatePreview(config);
        const length = Math.hypot(this.pullX, this.pullY);
        if (this.pullY >= 0 || length <= 0 || this.pullRatio < config.minimumFireRatio) {
            this.cancel(match);
            return null;
        }

        const directionX = -this.pullX / length;
        const directionY = -this.pullY / length;
        // 输入事件可能到达在下一次绘制之前。松手必须采用玩家最后实际看到的滑块值，
        // 避免画面仍在中心、逻辑滑块已经继续前进而产生意外大旋转。
        const capturedSpinRatio = clamp(renderedSliderRatio ?? this.sliderRatio, -1, 1);
        const initialSpin = capturedSpinRatio;
        const snapshot: LaunchSnapshot = {
            directionX,
            directionY,
            pullRatio: this.pullRatio,
            targetTravelDistance: targetTravelDistance(config, this.pullRatio),
            initialSpeed: this.initialSpeedPreview,
            spinRatio: capturedSpinRatio,
            initialSpin,
        };
        this.clearTouchAndPreview();
        return snapshot;
    }

    public cancel(match: MatchController): void {
        this.clearTouchAndPreview();
        match.cancelAim();
    }

    public reset(): void {
        this.activeTouchId = -1;
        this.sliderRatio = 0;
        this.sliderDirection = 1;
        this.clearPreview();
    }

    private updatePreview(config: ArcShotConfig): void {
        this.pullX = this.pointerX - this.lockedLaunchX;
        this.pullY = this.pointerY - this.lockedLaunchY;
        const distance = Math.hypot(this.pullX, this.pullY);
        this.pullRatio = clamp(distance / Math.max(1, config.maxPullDistance), 0, 1);
        this.initialSpeedPreview = initialSpeedForPullRatio(config, this.pullRatio);
    }

    private returnAimToReadyKeepingTouch(
        pointX: number,
        pointY: number,
        disc: DiscModel,
        match: MatchController,
    ): void {
        match.cancelAim();
        this.clearPreview();
        this.sliderRatio = 0;
        this.sliderDirection = 1;
        this.touchStartY = pointY;
        this.grabOffsetX = pointX - disc.x;
        this.grabOffsetY = pointY - disc.y;
        this.pointerX = disc.x;
        this.pointerY = disc.y;
    }

    private clearTouchAndPreview(): void {
        this.activeTouchId = -1;
        this.grabOffsetX = 0;
        this.grabOffsetY = 0;
        this.touchStartY = 0;
        this.clearPreview();
    }

    private clearPreview(): void {
        this.pullX = 0;
        this.pullY = 0;
        this.pullRatio = 0;
        this.initialSpeedPreview = 0;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
