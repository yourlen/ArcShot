import {
    _decorator,
    CCFloat,
    Color,
    Component,
    EditBox,
    EventTouch,
    game,
    Game,
    Graphics,
    HorizontalTextAlignment,
    Label,
    Node,
    profiler,
    ResolutionPolicy,
    UITransform,
    Vec3,
    VerticalTextAlignment,
    view,
} from 'cc';
import { EDITOR } from 'cc/env';
import { AimController, LaunchSnapshot } from '../core/AimController';
import {
    ArcShotConfig,
    initialSpeedForPullRatio,
    LOGIC_DT,
    MAX_LOGIC_FRAMES_PER_RENDER,
    targetTravelDistance,
    validateArcShotConfig,
} from '../core/ArcShotConfig';
import { DiscModel } from '../core/DiscModel';
import { MatchController } from '../core/MatchController';
import { PhysicsWorld } from '../core/PhysicsWorld';
import { PvpMatchCoordinator } from '../network/PvpMatchCoordinator';
import { CheckpointV1, ShotCommand } from '../shared/PvpTypes';

const { ccclass, executeInEditMode, property } = _decorator;

interface SliderFrameTrace {
    atMs: number;
    ratio: number;
    direction: number;
    logicTick: number;
    renderFrame: number;
}

interface ReleaseTrace {
    sequence: number;
    discId: string;
    releasedAtMs: number;
    lastRenderedAtMs: number;
    renderAgeMs: number;
    renderedRatio: number;
    logicRatio: number;
    capturedRatio: number;
    sliderDirection: number;
    logicTick: number;
    renderFrame: number;
    pullRatio: number;
    angleDegrees: number;
    recentFrames: SliderFrameTrace[];
}

/** ArcShot 本地双阵营可玩原型 v0.4。 */
@ccclass('ArcShotSceneLayout')
@executeInEditMode(true)
export class ArcShotSceneLayout extends Component {
    @property({ tooltip: '设计逻辑宽度' }) public designWidth = 1080;
    @property({ tooltip: '设计参考高度' }) public referenceHeight = 2400;
    @property({ tooltip: '桌面左边界' }) public tableLeftX = -480;
    @property({ tooltip: '桌面右边界' }) public tableRightX = 480;
    @property({ tooltip: '桌面视觉下边界，不是OUT边界' }) public tableBottomY = -1100;
    @property({ tooltip: '桌面上边界' }) public tableTopY = 900;
    @property({ tooltip: '发球线Y' }) public fireLineY = -695;
    @property({ tooltip: '发球线厚度' }) public fireLineThickness = 8;
    @property({ tooltip: '圆盘半径' }) public discRadius = 45;
    @property({ tooltip: '靶心X' }) public targetCenterX = 0;
    @property({ tooltip: '靶心Y' }) public targetCenterY = 590;
    @property({ type: [CCFloat], tooltip: '五圈半径，由内向外' })
    public scoreRingRadii: number[] = [45, 90, 135, 180, 225];
    @property({ type: [CCFloat], tooltip: '五圈得分，由内向外' })
    public scoreValues: number[] = [5, 4, 3, 2, 1];

    @property({ tooltip: '最大拉动距离' }) public maxPullDistance = 240;
    @property({ tooltip: '进入瞄准的累计向下距离' }) public aimActivationDistance = 45;
    @property({ tooltip: '是否允许READY圆盘左右拖动选择发球点' }) public allowLaunchPointDrag = false;
    @property({ tooltip: '最小有效发射比例' }) public minimumFireRatio = 0.05;
    @property({ tooltip: '100%力度对应的目标显示行程；当前65%直线球停在靶心' }) public targetTravelDistanceMax = 2046.154;
    @property({ tooltip: '离散积分速度标定行程；当前65%直线球停在靶心' }) public speedCalibrationDistance = 2050.133;

    @property({ tooltip: '旋转滑块从-1到+1的单程时间' }) public spinSliderOneWayTime = 1.00;
    @property({ tooltip: '弧线强度峰值所在的归一化行程' }) public curvePeakProgress = 0.82;
    @property({ tooltip: '起步弧线强度（相对峰值）' }) public curveStartStrength = 0.12;
    @property({ tooltip: '弧线上升侧指数' }) public curveRiseExponent = 2.2;
    @property({ tooltip: '当前包络的归一化面积' }) public curveEnvelopeArea = 0.444930656;
    @property({ tooltip: '弧线进度固定参考距离；不随本次力度变化' }) public curveReferenceDistance = 1330;
    @property({ tooltip: '满旋转整段累计最大转角（度）' }) public maxCurveHeadingDegrees = 45;
    @property({ tooltip: '碰撞后旋转保留比例' }) public collisionSpinRetention = 0.65;

    @property({ tooltip: '线速度匀减速度' }) public linearDeceleration = 650;
    @property({ tooltip: '线速度停止阈值' }) public stopSpeed = 45;
    @property({ tooltip: '等质量圆盘碰撞恢复系数' }) public collisionRestitution = 0.20;
    @property({ tooltip: '单微步最大碰撞事件数' }) public maxCollisionEventsPerMicrostep = 32;
    @property({ tooltip: '位置修正容差' }) public positionSlop = 0.01;
    @property({ tooltip: '位置修正最大轮数' }) public maxPositionIterations = 16;
    @property({ tooltip: '回合停稳表现时间' }) public settlingTime = 0.25;

    private _config: ArcShotConfig | null = null;
    private _match: MatchController | null = null;
    private _physics: PhysicsWorld | null = null;
    private _aim = new AimController();
    private _configErrors: string[] = [];
    private _lastConfigHash = '';
    private _accumulator = 0;
    private _backlogFrames = 0;
    private _paused = false;
    private _fps = 60;
    private _frameTimeMs = 1000 / 60;
    private _pressedUiTouchId = -1;
    private _pressedUi: 'RESTART' | 'RESULT_RESTART' | 'DEBUG_FIRE' | 'PVP_MATCH' | 'PVP_LATENCY' | 'PVP_DUP_COMMIT' | 'PVP_DESYNC' | 'PVP_LEAVE' | null = null;
    private _lastLaunch: LaunchSnapshot | null = null;
    private _lastRenderedSliderRatio = 0;
    private _lastRenderedSliderDirection = 1;
    private _lastRenderedAtMs = 0;
    private _logicTick = 0;
    private _renderFrame = 0;
    private _releaseSequence = 0;
    private _recentSliderFrames: SliderFrameTrace[] = [];
    private _lastReleaseTrace: ReleaseTrace | null = null;
    private _debugPowerEdit: EditBox | null = null;
    private _debugAngleEdit: EditBox | null = null;
    private _debugSpinEdit: EditBox | null = null;
    private _pvpRoomEdit: EditBox | null = null;
    private _pvp: PvpMatchCoordinator | null = null;
    private _isPvpMode = false;
    private _pvpLatencyIndex = 0;
    private _boundResultButton: Node | null = null;
    private _debugMessage = '角度：0°正上，正数向右，负数向左';

    private readonly _restartX = 390;
    private readonly _restartY = 985;
    private readonly _restartWidth = 170;
    private readonly _restartHeight = 70;
    private readonly _resultRestartX = 0;
    private readonly _resultRestartY = -150;
    private readonly _resultRestartWidth = 280;
    private readonly _resultRestartHeight = 90;
    private readonly _debugFireX = 360;
    private readonly _debugFireY = 890;
    private readonly _debugFireWidth = 180;
    private readonly _debugFireHeight = 54;
    private readonly _pvpMatchX = 40;
    private readonly _pvpLatencyX = 260;
    private readonly _pvpDuplicateX = -270;
    private readonly _pvpDesyncX = -30;
    private readonly _pvpLeaveX = 300;
    private readonly _pvpControlY = 890;

    protected onLoad(): void {
        profiler.hideStats();
        if (!EDITOR) {
            game.frameRate = 60;
            // 保持完整的竖屏设计画面。宽屏电脑在两侧留空，窄屏手机在
            // 上下留空，避免 FIXED_WIDTH 在桌面端只显示一整块桌面绿色。
            view.setDesignResolutionSize(
                this.designWidth,
                this.referenceHeight,
                ResolutionPolicy.SHOW_ALL,
            );
        }
        this.initializeGame();
    }

    protected onEnable(): void {
        profiler.hideStats();
        this.bindInput();
        game.on(Game.EVENT_HIDE, this.onGameHide, this);
        game.on(Game.EVENT_SHOW, this.onGameShow, this);
        if (!this._match) this.initializeGame();
    }

    protected onDisable(): void {
        this.unbindInput();
        game.off(Game.EVENT_HIDE, this.onGameHide, this);
        game.off(Game.EVENT_SHOW, this.onGameShow, this);
    }

    protected onDestroy(): void {
        this._boundResultButton?.off(Node.EventType.TOUCH_END, this.onResultButtonTouchEnd, this);
        this._boundResultButton = null;
        this._pvp?.dispose();
        this._pvp = null;
    }

    protected update(deltaTime: number): void {
        const nextHash = this.captureConfigHash();
        if (nextHash !== this._lastConfigHash) this.initializeGame();

        const safeDelta = Math.max(0, Number.isFinite(deltaTime) ? deltaTime : 0);
        if (safeDelta > 0) {
            this._fps = this._fps * 0.9 + (1 / safeDelta) * 0.1;
            this._frameTimeMs = this._frameTimeMs * 0.9 + safeDelta * 1000 * 0.1;
        }
        if (!EDITOR && !this._paused && this._configErrors.length === 0) {
            this._accumulator += safeDelta;
            let logicFrames = 0;
            while (this._accumulator + 1e-9 >= LOGIC_DT && logicFrames < MAX_LOGIC_FRAMES_PER_RENDER) {
                this._accumulator -= LOGIC_DT;
                this.stepLogicFrame();
                logicFrames += 1;
            }
            this._backlogFrames = Math.max(0, Math.floor(this._accumulator / LOGIC_DT));
        }
        this.drawScene();
    }

    private initializeGame(): void {
        this._pvp?.dispose();
        this._pvp = null;
        this._isPvpMode = detectPvpMode();
        this._config = this.buildConfig();
        this._configErrors = validateArcShotConfig(this._config);
        this._match = new MatchController(this._config);
        this._physics = new PhysicsWorld(this._config);
        if (this._isPvpMode) {
            this._match.setGameMode('LOCAL_WEB_PVP');
            this._pvp = new PvpMatchCoordinator({
                applyNetworkShot: command => this.applyNetworkShot(command),
                getNetworkCandidate: () => this._match?.getPendingCandidate() ?? null,
                loadNetworkCheckpoint: checkpoint => this.loadNetworkCheckpoint(checkpoint),
                getSimulationError: () => this._physics?.errors[0] ?? null,
                returnToLobby: () => this.returnToPvpLobby(),
            });
        }
        this._aim.reset();
        this._lastLaunch = null;
        this.resetReleaseTraceState(true);
        this._accumulator = 0;
        this._backlogFrames = 0;
        this._pressedUiTouchId = -1;
        this._pressedUi = null;
        this.ensureSceneNodes();
        this._lastConfigHash = this.captureConfigHash();
        this.drawScene();
    }

    private restartMatch(): void {
        if (this._isPvpMode) {
            this._pvp?.leave('USER');
            return;
        }
        this._aim.reset();
        this._physics?.reset();
        this._match?.restart();
        this._lastLaunch = null;
        this.resetReleaseTraceState(true);
        this._accumulator = 0;
        this._backlogFrames = 0;
        this._pressedUiTouchId = -1;
        this._pressedUi = null;
        this.drawScene();
    }

    private stepLogicFrame(): void {
        const match = this._match;
        const physics = this._physics;
        const config = this._config;
        if (!match || !physics || !config) return;
        this._aim.updateSlider(LOGIC_DT, match.currentDisc, config);
        this._logicTick += 1;
        if (match.state === 'TURN_SIMULATING') physics.stepLogicFrame(match.discs);
        match.afterLogicFrame();
        this._pvp?.pollSimulation();
    }

    private bindInput(): void {
        if (EDITOR) return;
        this.unbindInput();
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    private unbindInput(): void {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    private onTouchStart(event: EventTouch): void {
        if (this._pressedUiTouchId >= 0 || this._aim.activeTouchId >= 0) return;
        const point = this.toCanvasPoint(event);
        const match = this._match;
        if (!match) return;
        if (this._isPvpMode) {
            if (!this._pvp?.inRoom && this.hitRect(point.x, point.y, this._pvpMatchX, this._pvpControlY, 190, 58)) {
                this._pressedUiTouchId = event.getID();
                this._pressedUi = 'PVP_MATCH';
                return;
            }
            if (!this._pvp?.inRoom && this.hitRect(point.x, point.y, this._pvpLatencyX, this._pvpControlY, 160, 58)) {
                this._pressedUiTouchId = event.getID();
                this._pressedUi = 'PVP_LATENCY';
                return;
            }
            if (this._pvp?.inRoom && this.hitRect(point.x, point.y, this._pvpLeaveX, this._pvpControlY, 140, 58)) {
                this._pressedUiTouchId = event.getID();
                this._pressedUi = 'PVP_LEAVE';
                return;
            }
            if (this._pvp?.inRoom && this.hitRect(point.x, point.y, this._pvpDuplicateX, this._pvpControlY, 210, 58)) {
                this._pressedUiTouchId = event.getID();
                this._pressedUi = 'PVP_DUP_COMMIT';
                return;
            }
            if (this._pvp?.inRoom && this.hitRect(point.x, point.y, this._pvpDesyncX, this._pvpControlY, 210, 58)) {
                this._pressedUiTouchId = event.getID();
                this._pressedUi = 'PVP_DESYNC';
                return;
            }
            if (this._pvp?.inRoom && match.state === 'MATCH_RESULT'
                && this.hitRect(point.x, point.y, this._resultRestartX, this._resultRestartY, this._resultRestartWidth, this._resultRestartHeight)) {
                this._pressedUiTouchId = event.getID();
                this._pressedUi = 'RESULT_RESTART';
                return;
            }
            if (!this._pvp?.canLocalInput || match.state !== 'TURN_READY') return;
            this._aim.tryBeginTouch(event.getID(), point.x, point.y, match.currentDisc);
            return;
        }
        if (this.hitRect(point.x, point.y, this._restartX, this._restartY, this._restartWidth, this._restartHeight)) {
            this._pressedUiTouchId = event.getID();
            this._pressedUi = 'RESTART';
            return;
        }
        if (match.state === 'MATCH_RESULT' && this.hitRect(point.x, point.y, this._resultRestartX, this._resultRestartY, this._resultRestartWidth, this._resultRestartHeight)) {
            this._pressedUiTouchId = event.getID();
            this._pressedUi = 'RESULT_RESTART';
            return;
        }
        if (match.state === 'TURN_READY' && this.hitRect(point.x, point.y, this._debugFireX, this._debugFireY, this._debugFireWidth, this._debugFireHeight)) {
            this._pressedUiTouchId = event.getID();
            this._pressedUi = 'DEBUG_FIRE';
            return;
        }
        if (match.state !== 'TURN_READY') return;
        this._aim.tryBeginTouch(event.getID(), point.x, point.y, match.currentDisc);
    }

    private onTouchMove(event: EventTouch): void {
        if (event.getID() !== this._aim.activeTouchId) return;
        const point = this.toCanvasPoint(event);
        if (this._match && this._config) {
            const disc = this._match.currentDisc;
            const previousState = disc?.state;
            this._aim.moveTouch(event.getID(), point.x, point.y, disc, this._match, this._config);
            if (previousState === 'READY' && disc?.state === 'AIMING') {
                this._lastRenderedSliderRatio = this._aim.sliderRatio;
            } else if (previousState === 'AIMING' && disc?.state === 'READY') {
                this._lastRenderedSliderRatio = 0;
            }
        }
    }

    private onTouchEnd(event: EventTouch): void {
        if (event.getID() === this._pressedUiTouchId) {
            const point = this.toCanvasPoint(event);
            const pressed = this._pressedUi;
            this._pressedUiTouchId = -1;
            this._pressedUi = null;
            const releasedInside = this.pressedUiContainsPoint(pressed, point.x, point.y);
            if (releasedInside) {
                if (pressed === 'DEBUG_FIRE') {
                    this.launchDebugShot();
                } else if (pressed === 'PVP_MATCH') {
                    const latency = [0, 100, 300, 500][this._pvpLatencyIndex] ?? 0;
                    this._pvp?.connectAndJoin(this._pvpRoomEdit?.string ?? '', latency);
                } else if (pressed === 'PVP_LATENCY') {
                    this._pvpLatencyIndex = (this._pvpLatencyIndex + 1) % 4;
                } else if (pressed === 'PVP_DUP_COMMIT') {
                    this._pvp?.toggleDuplicateNextCommit();
                } else if (pressed === 'PVP_DESYNC') {
                    this._pvp?.toggleGuestDesyncNextResult();
                } else if (pressed === 'PVP_LEAVE') {
                    this._pvp?.leave('USER');
                } else {
                    this.restartMatch();
                }
            }
            return;
        }
        if (event.getID() !== this._aim.activeTouchId) return;
        const match = this._match;
        const config = this._config;
        const physics = this._physics;
        if (!match || !config || !physics) return;
        const point = this.toCanvasPoint(event);
        const releasedAtMs = nowMs();
        const stateBeforeFinalMove = match.currentDisc?.state;
        this._aim.moveTouch(event.getID(), point.x, point.y, match.currentDisc, match, config);
        if (stateBeforeFinalMove === 'READY' && match.currentDisc?.state === 'AIMING') {
            this._lastRenderedSliderRatio = this._aim.sliderRatio;
        } else if (stateBeforeFinalMove === 'AIMING' && match.currentDisc?.state === 'READY') {
            this._lastRenderedSliderRatio = 0;
        }
        const disc = match.currentDisc;
        const logicRatioAtRelease = this._aim.sliderRatio;
        const sliderDirectionAtRelease = this._aim.sliderDirection;
        const launch = this._aim.releaseTouch(
            event.getID(),
            point.x,
            point.y,
            disc,
            match,
            config,
            this._lastRenderedSliderRatio,
        );
        if (!launch || !disc) return;
        this.captureReleaseTrace(
            disc.id,
            releasedAtMs,
            logicRatioAtRelease,
            sliderDirectionAtRelease,
            launch,
        );
        const command: ShotCommand = {
            directionX: launch.directionX,
            directionY: launch.directionY,
            pullRatio: launch.pullRatio,
            curveRatio: launch.spinRatio,
        };
        if (this._isPvpMode) {
            if (this._pvp?.submitLocalShot(command)) {
                this._lastLaunch = launch;
                match.cancelAim();
            } else {
                match.cancelAim();
            }
            return;
        }
        physics.beginTurn();
        physics.createLaunchIgnorePairs(disc, match.discs);
        if (match.applyCommittedShot(command)) {
            this._lastLaunch = launch;
        } else {
            match.cancelAim();
        }
    }

    private onTouchCancel(event: EventTouch): void {
        if (event.getID() === this._pressedUiTouchId) {
            this._pressedUiTouchId = -1;
            this._pressedUi = null;
        }
        if (event.getID() === this._aim.activeTouchId && this._match) this._aim.cancel(this._match);
    }

    private onGameHide(): void {
        this._paused = true;
        this._accumulator = 0;
        if (this._aim.activeTouchId >= 0 && this._match) this._aim.cancel(this._match);
        if (this._isPvpMode && this._pvp?.inRoom) this._pvp.leave('PAGE_HIDDEN');
    }

    private onGameShow(): void {
        this._paused = false;
        this._accumulator = 0;
    }

    private drawScene(): void {
        this._renderFrame += 1;
        const config = this._config;
        const match = this._match;
        if (!config || !match) return;
        const background = this.ensureChild(this.node, 'SolidBackground', 0);
        const table = this.ensureChild(this.node, 'Table', 1);
        const items = this.ensureChild(this.node, 'TableItems', 2);
        this.drawBackground(background, config);
        this.drawTable(table, config);
        this.drawItems(items, config, match);
        this.updateLabels(items, match);
    }

    private drawBackground(node: Node, config: ArcShotConfig): void {
        node.setPosition(0, 0, 0);
        this.ensureTransform(node).setContentSize(config.designWidth, config.referenceHeight);
        const graphics = this.ensureGraphics(node);
        graphics.clear();
        this.appendRect(graphics, 0, 0, config.designWidth, config.referenceHeight, new Color(210, 203, 190, 255));
    }

    private drawTable(node: Node, config: ArcShotConfig): void {
        node.setPosition(0, 0, 0);
        this.ensureTransform(node).setContentSize(config.designWidth, config.referenceHeight);
        const graphics = this.ensureGraphics(node);
        graphics.clear();
        this.appendRect(graphics, (config.tableLeftX + config.tableRightX) * 0.5, (config.tableBottomY + config.tableTopY) * 0.5, config.tableRightX - config.tableLeftX, config.tableTopY - config.tableBottomY, new Color(57, 115, 96, 255), new Color(171, 218, 190, 255), 8);
    }

    private drawItems(node: Node, config: ArcShotConfig, match: MatchController): void {
        node.setPosition(0, 0, 0);
        this.ensureTransform(node).setContentSize(config.designWidth, config.referenceHeight);
        const graphics = this.ensureGraphics(node);
        graphics.clear();
        const ringColors = [new Color(250, 249, 240, 255), new Color(231, 111, 81, 255), new Color(244, 162, 97, 255), new Color(42, 157, 143, 255), new Color(233, 196, 106, 255)];
        for (let index = config.scoreRingRadii.length - 1; index >= 0; index -= 1) {
            this.appendCircle(graphics, config.targetCenterX, config.targetCenterY, config.scoreRingRadii[index] * 2, ringColors[index], new Color(248, 249, 250, 210), 3);
        }
        this.appendRect(graphics, (config.tableLeftX + config.tableRightX) * 0.5, config.fireLineY, config.tableRightX - config.tableLeftX, config.fireLineThickness, new Color(244, 211, 94, 255));
        for (const disc of match.discs) this.drawDiscTrail(graphics, disc);
        for (const disc of match.discs) {
            if (disc.state === 'UNUSED' || disc.state === 'OUT') continue;
            const fill = disc.camp === 'RED' ? new Color(211, 76, 70, 255) : new Color(63, 132, 220, 255);
            const isCurrent = disc === match.currentDisc && (disc.state === 'READY' || disc.state === 'AIMING');
            this.appendCircle(graphics, disc.x, disc.y, disc.radius * 2, fill, isCurrent ? new Color(255, 232, 130, 255) : new Color(245, 245, 238, 245), isCurrent ? 7 : 4);
        }
        if (match.currentDisc?.state === 'AIMING') this.drawAimPreview(graphics, match.currentDisc, config);
        this.drawHudChrome(graphics, match);
        if (this._isPvpMode) this.drawPvpChrome(graphics);
    }

    private drawPvpChrome(graphics: Graphics): void {
        const connected = this._pvp?.inRoom ?? false;
        this.appendRect(graphics, 0, 985, 960, 70, new Color(29, 43, 56, 250), new Color(238, 224, 188, 230), 3);
        this.appendRect(graphics, 0, this._pvpControlY, 960, 100, new Color(20, 31, 41, 248), new Color(238, 224, 188, 220), 3);
        if (!connected) {
            this.appendRect(graphics, -270, this._pvpControlY, 260, 58, new Color(245, 241, 225, 255), new Color(238, 162, 97, 255), 3);
            this.appendRect(graphics, this._pvpMatchX, this._pvpControlY, 190, 58, new Color(238, 125, 78, 255), new Color(255, 246, 222, 255), 3);
            this.appendRect(graphics, this._pvpLatencyX, this._pvpControlY, 160, 58, new Color(50, 77, 96, 255), new Color(230, 238, 240, 230), 3);
        } else {
            this.appendRect(graphics, this._pvpDuplicateX, this._pvpControlY, 210, 58, this._pvp?.duplicateCommitArmed ? new Color(238, 125, 78, 255) : new Color(50, 77, 96, 255), new Color(230, 238, 240, 230), 3);
            this.appendRect(graphics, this._pvpDesyncX, this._pvpControlY, 210, 58, this._pvp?.guestDesyncArmed ? new Color(238, 125, 78, 255) : new Color(50, 77, 96, 255), new Color(230, 238, 240, 230), 3);
            this.appendRect(graphics, this._pvpLeaveX, this._pvpControlY, 140, 58, new Color(160, 70, 62, 255), new Color(255, 230, 218, 240), 3);
        }
        this.appendRect(graphics, 180, -910, 540, 330, new Color(16, 24, 31, 235), new Color(102, 190, 220, 220), 3);
    }

    private drawDiscTrail(graphics: Graphics, disc: DiscModel): void {
        if (disc.trail.length < 2) return;
        graphics.strokeColor = disc.camp === 'RED'
            ? new Color(255, 105, 95, 190)
            : new Color(105, 170, 255, 190);
        graphics.lineWidth = 10;
        graphics.moveTo(disc.trail[0].x, disc.trail[0].y);
        for (let index = 1; index < disc.trail.length; index += 1) {
            graphics.lineTo(disc.trail[index].x, disc.trail[index].y);
        }
        graphics.stroke();
    }

    private drawAimPreview(graphics: Graphics, disc: DiscModel, config: ArcShotConfig): void {
        this._lastRenderedSliderRatio = this._aim.sliderRatio;
        this._lastRenderedSliderDirection = this._aim.sliderDirection;
        this._lastRenderedAtMs = nowMs();
        this._recentSliderFrames.push({
            atMs: this._lastRenderedAtMs,
            ratio: this._lastRenderedSliderRatio,
            direction: this._lastRenderedSliderDirection,
            logicTick: this._logicTick,
            renderFrame: this._renderFrame,
        });
        if (this._recentSliderFrames.length > 12) {
            this._recentSliderFrames.splice(0, this._recentSliderFrames.length - 12);
        }
        graphics.strokeColor = this._aim.pullY < 0 ? new Color(255, 225, 122, 230) : new Color(235, 90, 80, 230);
        graphics.lineWidth = 6;
        graphics.moveTo(disc.x, disc.y);
        graphics.lineTo(this._aim.pointerX, this._aim.pointerY);
        graphics.stroke();
        const pullLength = Math.hypot(this._aim.pullX, this._aim.pullY);
        if (pullLength > 0) {
            const directionX = -this._aim.pullX / pullLength;
            const directionY = -this._aim.pullY / pullLength;
            const indicatorLength = 80 + this._aim.pullRatio * 100;
            const endX = disc.x + directionX * indicatorLength;
            const endY = disc.y + directionY * indicatorLength;
            graphics.strokeColor = new Color(255, 250, 230, 245);
            graphics.lineWidth = 8;
            graphics.moveTo(disc.x, disc.y);
            graphics.lineTo(endX, endY);
            graphics.stroke();
            this.appendCircle(graphics, endX, endY, 18, new Color(255, 250, 230, 255), new Color(255, 250, 230, 255), 1);
        }
        // 下拉发射时手指会停留在球的下方，因此摆动条放在球的上方，
        // 避免手指和手掌遮住旋转时机。
        const sliderY = this.spinSliderY(disc);
        this.appendRect(graphics, 0, sliderY, 440, 40, new Color(31, 43, 55, 225), new Color(245, 230, 190, 230), 3);
        this.appendCircle(graphics, this._aim.sliderRatio * 200, sliderY, 34, new Color(244, 162, 97, 255), new Color(255, 249, 233, 255), 3);
        const barHeight = config.maxPullDistance;
        const barX = config.tableRightX - 28;
        const barCenterY = config.fireLineY - disc.radius - barHeight * 0.5;
        this.appendRect(graphics, barX, barCenterY, 18, barHeight, new Color(20, 30, 38, 160), new Color(245, 230, 190, 180), 2);
        if (this._aim.pullRatio > 0) {
            const fillHeight = barHeight * this._aim.pullRatio;
            this.appendRect(graphics, barX, barCenterY - (barHeight - fillHeight) * 0.5, 14, fillHeight, new Color(238, 125, 78, 245));
        }
    }

    private drawHudChrome(graphics: Graphics, match: MatchController): void {
        this.appendRect(graphics, -300, 1080, 320, 90, new Color(116, 42, 44, 235), new Color(250, 220, 205, 230), 3);
        this.appendRect(graphics, 300, 1080, 320, 90, new Color(35, 70, 124, 235), new Color(215, 230, 255, 230), 3);
        this.appendRect(graphics, 0, 985, 360, 70, new Color(35, 48, 60, 235), new Color(240, 230, 202, 220), 3);
        this.appendRect(graphics, this._restartX, this._restartY, this._restartWidth, this._restartHeight, new Color(238, 125, 78, 255), new Color(255, 246, 222, 255), 3);
        this.appendRect(graphics, 0, 900, 960, 100, new Color(20, 31, 41, 235), new Color(238, 224, 188, 220), 3);
        this.appendRect(graphics, -330, this._debugFireY, 190, this._debugFireHeight, new Color(245, 241, 225, 255), new Color(238, 162, 97, 255), 3);
        this.appendRect(graphics, -105, this._debugFireY, 190, this._debugFireHeight, new Color(245, 241, 225, 255), new Color(238, 162, 97, 255), 3);
        this.appendRect(graphics, 120, this._debugFireY, 190, this._debugFireHeight, new Color(245, 241, 225, 255), new Color(238, 162, 97, 255), 3);
        this.appendRect(graphics, this._debugFireX, this._debugFireY, this._debugFireWidth, this._debugFireHeight, match.state === 'TURN_READY' ? new Color(238, 125, 78, 255) : new Color(100, 100, 100, 220), new Color(255, 246, 222, 255), 3);
        this.appendRect(graphics, -330, -910, 280, 330, new Color(16, 24, 31, 195), new Color(225, 233, 224, 140), 2);
        if (this._lastReleaseTrace) {
            this.appendRect(graphics, 180, -910, 540, 330, new Color(16, 24, 31, 225), new Color(255, 194, 112, 220), 3);
        }
        if (match.state === 'MATCH_RESULT') {
            this.appendRect(graphics, 0, 0, 700, 500, new Color(18, 27, 35, 245), new Color(255, 235, 180, 245), 6);
            this.appendRect(graphics, this._resultRestartX, this._resultRestartY, this._resultRestartWidth, this._resultRestartHeight, new Color(238, 125, 78, 255), new Color(255, 246, 222, 255), 4);
        }
        if (this._configErrors.length > 0) this.appendRect(graphics, 0, 0, 900, 500, new Color(90, 20, 25, 245), new Color(255, 180, 170, 255), 5);
    }

    private updateLabels(items: Node, match: MatchController): void {
        this.setLabel(items, 'RedInfo', -300, 1080, 300, 70, `红方  分数 ${match.redScore}  未发 ${match.unlaunchedCount('RED')}`, 27, new Color(255, 236, 224, 255));
        this.setLabel(items, 'BlueInfo', 300, 1080, 300, 70, `蓝方  分数 ${match.blueScore}  未发 ${match.unlaunchedCount('BLUE')}`, 27, new Color(230, 240, 255, 255));
        this.setLabel(items, 'TurnInfo', 0, 985, 340, 55, this.turnText(match), 21, new Color(255, 248, 228, 255));
        this.setLabel(items, 'RestartLabel', this._restartX, this._restartY, this._restartWidth, this._restartHeight, '重新开始', 25, new Color(255, 250, 237, 255));
        this.setLabel(items, 'DebugPowerTitle', -330, 930, 190, 24, '力度 %', 18, new Color(255, 244, 214, 255));
        this.setLabel(items, 'DebugAngleTitle', -105, 930, 190, 24, '角度°（+右）', 18, new Color(255, 244, 214, 255));
        this.setLabel(items, 'DebugSpinTitle', 120, 930, 190, 24, '旋转 -1～1', 18, new Color(255, 244, 214, 255));
        this.setLabel(items, 'DebugFireLabel', this._debugFireX, this._debugFireY, this._debugFireWidth, this._debugFireHeight, '参数发射', 21, new Color(255, 250, 237, 255));
        this.setLabel(items, 'DebugStatus', 0, 835, 900, 30, this._debugMessage, 17, new Color(255, 238, 188, 255));
        const current = match.currentDisc;
        const displacementX = current ? current.x - current.launchStartX : 0;
        const displacementY = current ? current.y - current.launchStartY : 0;
        const longitudinalOffset = current
            ? displacementX * current.launchDirectionX + displacementY * current.launchDirectionY
            : 0;
        const lateralOffset = current
            ? displacementX * current.launchDirectionY - displacementY * current.launchDirectionX
            : 0;
        const debugLines = [
            `Match ${match.state}  T${Math.min(match.turnIndex + 1, 8)} ${current?.id ?? '--'} ${current?.state ?? '--'}`,
            `Pos ${current ? `${current.x.toFixed(1)},${current.y.toFixed(1)}` : '--'}  Speed ${current?.speed.toFixed(1) ?? '--'}`,
            `Pull ${(this._lastLaunch?.pullRatio ?? this._aim.pullRatio).toFixed(3)}  Initial ${(current?.state === 'AIMING' ? this._aim.initialSpeedPreview : this._lastLaunch?.initialSpeed ?? 0).toFixed(1)}`,
            `Target ${current?.plannedDistance.toFixed(2) ?? '--'}  Calib ${this.speedCalibrationDistance.toFixed(3)}`,
            `Actual ${current?.actualTravelDistance.toFixed(2) ?? '--'}  Micro ${current?.microstepTravelDistance.toFixed(3) ?? '--'}`,
            `Progress ${current?.curveProgress.toFixed(4) ?? '--'}  Free ${current?.freeTravelBudget.toFixed(3) ?? '--'}`,
            `Captured ${current?.capturedSpinRatio.toFixed(3) ?? '--'}  Amplitude ${current?.spin.toFixed(3) ?? '--'}`,
            `Envelope ${current?.curveEnvelope.toFixed(4) ?? '--'}  dU ${current?.deltaProgress.toFixed(5) ?? '--'}`,
            `dHeading ${current ? (current.deltaHeading * 180 / Math.PI).toFixed(3) : '--'} deg`,
            `Long ${longitudinalOffset.toFixed(1)}  Lateral ${lateralOffset.toFixed(1)}`,
            `Correction ${current?.correctionDistance.toFixed(3) ?? '--'}  Hit ${this._physics?.currentTurnCollisionCount ?? 0}`,
            `Motion ${current?.motionTime.toFixed(2) ?? '0.00'}s  OUT ${current?.state === 'OUT' ? 'YES' : 'NO'}`,
            `FPS ${this._fps.toFixed(1)}  Backlog ${this._backlogFrames}  Ignore ${this._physics?.launchIgnorePairs.size ?? 0}`,
            `Errors: ${this._physics?.errors.join(',') || '--'}`,
        ];
        this.setLabel(items, 'DebugText', -330, -910, 255, 305, debugLines.join('\n'), 14, new Color(245, 246, 241, 255), HorizontalTextAlignment.LEFT);
        const releaseLogNode = this.setLabel(
            items,
            'ReleaseLogText',
            180,
            -910,
            510,
            305,
            this.formatReleaseTrace(),
            14,
            new Color(255, 244, 220, 255),
            HorizontalTextAlignment.LEFT,
        );
        releaseLogNode.active = this._lastReleaseTrace !== null;
        const sliderText = match.currentDisc?.state === 'AIMING'
            ? `左弧  ←  旋转 ${this._aim.sliderRatio.toFixed(2)}  →  右弧    力度 ${(this._aim.pullRatio * 100).toFixed(0)}%`
            : '';
        const sliderTextY = current ? this.spinSliderY(current) + 45 : -570;
        this.setLabel(items, 'SliderText', 0, sliderTextY, 500, 35, sliderText, 20, new Color(255, 245, 220, 255));
        const discLabelsRoot = this.ensureChild(items, 'DiscLabels', 0);
        for (const disc of match.discs) {
            const labelNode = this.ensureChild(discLabelsRoot, `Disc_${disc.id}`, disc.order);
            labelNode.active = disc.state !== 'UNUSED' && disc.state !== 'OUT';
            if (labelNode.active) this.configureLabel(labelNode, disc.x, disc.y, disc.radius * 2, disc.radius * 2, disc.id, 20, new Color(255, 250, 238, 255));
        }
        const showResult = match.state === 'MATCH_RESULT';
        const resultActionText = this._isPvpMode ? '返回匹配' : '重新开始';
        const resultNode = this.setLabel(
            items,
            'ResultText',
            0,
            80,
            620,
            260,
            showResult ? `${match.winnerText}\n\n红方 ${match.redScore}  :  ${match.blueScore} 蓝方` : '',
            42,
            new Color(255, 244, 210, 255),
        );
        const resultLabel = resultNode.getComponent(Label);
        if (resultLabel) {
            resultLabel.overflow = Label.Overflow.CLAMP;
            resultLabel.enableWrapText = true;
            resultLabel.updateRenderData(true);
        }
        resultNode.active = showResult;
        const resultButtonName = this._isPvpMode ? 'PvpResultRestartLabel' : 'ResultRestartLabel';
        let resultButton = items.getChildByName(resultButtonName);
        if (showResult) {
            // The scene's legacy ResultRestartLabel starts inactive. On Web builds,
            // mutating that inactive label and enabling it in the same frame can
            // leave its render data empty. Create the PVP result label only when
            // the result is visible, then bind the node itself as a reliable hit target.
            // ResultText also contains the caption as a fallback. Force this
            // dedicated label to CLAMP so Web creates render data for the fixed
            // button bounds instead of auto-resizing an inactive scene label.
            resultButton = this.setLabel(items, resultButtonName, this._resultRestartX, this._resultRestartY, this._resultRestartWidth, this._resultRestartHeight, resultActionText, 30, new Color(255, 250, 237, 255));
            const resultButtonLabel = resultButton.getComponent(Label);
            if (resultButtonLabel) {
                resultButtonLabel.overflow = Label.Overflow.CLAMP;
                resultButtonLabel.enableWrapText = false;
                resultButtonLabel.updateRenderData(true);
            }
            resultButton.active = true;
            this.bindResultButton(resultButton);
        } else if (resultButton) {
            resultButton.active = false;
        }
        const errorNode = this.setLabel(items, 'ConfigErrors', 0, 0, 820, 440, this._configErrors.length > 0 ? `参数错误\n${this._configErrors.join('\n')}` : '', 24, new Color(255, 225, 215, 255));
        errorNode.active = this._configErrors.length > 0;
        if (this._isPvpMode) this.updatePvpLabels(items);
    }

    private updatePvpLabels(items: Node): void {
        const hiddenNames = [
            'TurnInfo', 'RestartLabel', 'DebugPowerTitle', 'DebugAngleTitle', 'DebugSpinTitle',
            'DebugFireLabel', 'DebugStatus', 'ReleaseLogText',
        ];
        for (const name of hiddenNames) {
            const node = items.getChildByName(name);
            if (node) node.active = false;
        }
        const connected = this._pvp?.inRoom ?? false;
        const roomInput = items.getChildByName('PvpRoomInput');
        if (roomInput) roomInput.active = !connected;
        const status = this.setLabel(
            items,
            'PvpStatus',
            0,
            985,
            920,
            55,
            this._pvp?.statusText ?? 'PVP未初始化',
            22,
            new Color(245, 239, 218, 255),
        );
        status.active = true;
        const matchLabel = this.setLabel(
            items,
            'PvpMatchLabel',
            this._pvpMatchX,
            this._pvpControlY,
            190,
            58,
            '匹配',
            23,
            new Color(255, 250, 237, 255),
        );
        matchLabel.active = !connected;
        const latency = [0, 100, 300, 500][this._pvpLatencyIndex] ?? 0;
        const latencyLabel = this.setLabel(
            items,
            'PvpLatencyLabel',
            this._pvpLatencyX,
            this._pvpControlY,
            160,
            58,
            `延迟 ${latency}ms`,
            19,
            new Color(235, 243, 246, 255),
        );
        latencyLabel.active = !connected;
        const leaveLabel = this.setLabel(
            items,
            'PvpLeaveLabel',
            this._pvpLeaveX,
            this._pvpControlY,
            140,
            58,
            '离开对局',
            20,
            new Color(255, 240, 228, 255),
        );
        leaveLabel.active = connected;
        const duplicateLabel = this.setLabel(
            items,
            'PvpDuplicateCommitLabel',
            this._pvpDuplicateX,
            this._pvpControlY,
            210,
            58,
            `重复COMMIT ${this._pvp?.duplicateCommitArmed ? '开' : '关'}`,
            17,
            new Color(235, 243, 246, 255),
        );
        duplicateLabel.active = connected;
        const desyncLabel = this.setLabel(
            items,
            'PvpDesyncLabel',
            this._pvpDesyncX,
            this._pvpControlY,
            210,
            58,
            `Guest失步 ${this._pvp?.guestDesyncArmed ? '开' : '关'}`,
            17,
            new Color(235, 243, 246, 255),
        );
        desyncLabel.active = connected;
        const debugNode = this.setLabel(
            items,
            'PvpDebugText',
            180,
            -910,
            510,
            305,
            this._pvp?.debugText() ?? '',
            14,
            new Color(226, 244, 247, 255),
            HorizontalTextAlignment.LEFT,
        );
        debugNode.active = true;
    }

    private turnText(match: MatchController): string {
        const disc = match.currentDisc;
        if (match.state === 'MATCH_RESULT') return '本局结束';
        if (match.state === 'TURN_SIMULATING') return `${disc?.id ?? ''} 运动中`;
        if (match.state === 'TURN_SETTLING') return '圆盘停稳中';
        if (match.state === 'TURN_AIMING') return `${disc?.id ?? ''} 瞄准中`;
        return `${disc?.id ?? ''} ${disc?.camp === 'RED' ? '红方' : '蓝方'}回合`;
    }

    private captureReleaseTrace(
        discId: string,
        releasedAtMs: number,
        logicRatio: number,
        sliderDirection: number,
        launch: LaunchSnapshot,
    ): void {
        const lastRenderedAtMs = this._lastRenderedAtMs;
        const trace: ReleaseTrace = {
            sequence: this._releaseSequence + 1,
            discId,
            releasedAtMs,
            lastRenderedAtMs,
            renderAgeMs: lastRenderedAtMs > 0 ? Math.max(0, releasedAtMs - lastRenderedAtMs) : -1,
            renderedRatio: this._lastRenderedSliderRatio,
            logicRatio,
            capturedRatio: launch.spinRatio,
            sliderDirection,
            logicTick: this._logicTick,
            renderFrame: this._renderFrame,
            pullRatio: launch.pullRatio,
            angleDegrees: Math.atan2(launch.directionX, launch.directionY) * 180 / Math.PI,
            recentFrames: this._recentSliderFrames.map(frame => ({ ...frame })),
        };
        this._releaseSequence = trace.sequence;
        this._lastReleaseTrace = trace;
        console.info('[ArcShot][RELEASE_TRACE]', JSON.stringify(trace));
    }

    private formatReleaseTrace(): string {
        const trace = this._lastReleaseTrace;
        if (!trace) return '';
        const direction = trace.sliderDirection >= 0 ? '向右' : '向左';
        const age = trace.renderAgeMs >= 0 ? `${trace.renderAgeMs.toFixed(2)} ms` : '--';
        const samples = trace.recentFrames
            .slice(-8)
            .map(frame => {
                const offset = frame.atMs - trace.releasedAtMs;
                return `${offset.toFixed(0)}:${signed(frame.ratio)}`;
            })
            .join('  ');
        return [
            `RELEASE LOG #${trace.sequence}  ${trace.discId}`,
            `松手时间 ${trace.releasedAtMs.toFixed(2)} ms`,
            `最后绘制 ${trace.lastRenderedAtMs.toFixed(2)} ms  画面龄 ${age}`,
            `画面 ${signed(trace.renderedRatio)}  逻辑 ${signed(trace.logicRatio)}`,
            `提交 ${signed(trace.capturedRatio)}  摆动 ${direction}`,
            `力度 ${(trace.pullRatio * 100).toFixed(2)}%  角度 ${signed(trace.angleDegrees)}°`,
            `Logic ${trace.logicTick}  Render ${trace.renderFrame}`,
            `松手前帧（ms:旋转）`,
            samples || '--',
        ].join('\n');
    }

    private resetReleaseTraceState(clearLatest: boolean): void {
        this._lastRenderedSliderRatio = 0;
        this._lastRenderedSliderDirection = 1;
        this._lastRenderedAtMs = 0;
        this._logicTick = 0;
        this._renderFrame = 0;
        this._recentSliderFrames.length = 0;
        if (clearLatest) {
            this._releaseSequence = 0;
            this._lastReleaseTrace = null;
        }
    }

    private ensureSceneNodes(): void {
        this.ensureTransform(this.node).setContentSize(this.designWidth, this.referenceHeight);
        for (const name of ['Background', 'FieldRoot', 'TopUIPlaceholder', 'UISafeAreaGuide', 'TableRoot']) this.removeChildIfPresent(this.node, name);
        const items = this.ensureChild(this.node, 'TableItems', 2);
        for (const name of ['DebugControls', 'FrictionControl', 'ResetButton']) this.removeChildIfPresent(items, name);
        if (this._isPvpMode) {
            for (const name of ['DebugPowerInput', 'DebugAngleInput', 'DebugSpinInput']) {
                this.removeChildIfPresent(items, name);
            }
            this._debugPowerEdit = null;
            this._debugAngleEdit = null;
            this._debugSpinEdit = null;
            this._pvpRoomEdit = this.ensureDebugEditBox(items, 'PvpRoomInput', -270, this._pvpControlY, 260, 58, '123456');
            this._pvpRoomEdit.maxLength = 6;
        } else {
            this.removeChildIfPresent(items, 'PvpRoomInput');
            this._pvpRoomEdit = null;
            this._debugPowerEdit = this.ensureDebugEditBox(items, 'DebugPowerInput', -330, this._debugFireY, 190, this._debugFireHeight, '76.716');
            this._debugAngleEdit = this.ensureDebugEditBox(items, 'DebugAngleInput', -105, this._debugFireY, 190, this._debugFireHeight, '-13.104');
            this._debugSpinEdit = this.ensureDebugEditBox(items, 'DebugSpinInput', 120, this._debugFireY, 190, this._debugFireHeight, '1');
        }
        this.ensureChild(this.node, 'SolidBackground', 0);
        this.ensureChild(this.node, 'Table', 1);
    }

    private launchDebugShot(): void {
        if (this._isPvpMode) return;
        const match = this._match;
        const physics = this._physics;
        const config = this._config;
        const disc = match?.currentDisc;
        if (!match || !physics || !config || !disc || match.state !== 'TURN_READY' || disc.state !== 'READY') return;

        const powerPercent = Number(this._debugPowerEdit?.string.trim());
        const angleDegrees = Number(this._debugAngleEdit?.string.trim());
        const spinRatioInput = Number(this._debugSpinEdit?.string.trim());
        if (![powerPercent, angleDegrees, spinRatioInput].every(Number.isFinite)) {
            this._debugMessage = '参数错误：请输入有效数字';
            return;
        }

        const pullRatio = clamp(powerPercent / 100, 0, 1);
        if (pullRatio < config.minimumFireRatio) {
            this._debugMessage = `参数错误：力度至少 ${(config.minimumFireRatio * 100).toFixed(1)}%`;
            return;
        }
        const angle = clamp(angleDegrees, -89.9, 89.9) * Math.PI / 180;
        const spinRatio = clamp(spinRatioInput, -1, 1);
        const directionX = Math.sin(angle);
        const directionY = Math.cos(angle);
        const initialSpeed = initialSpeedForPullRatio(config, pullRatio);
        const initialSpin = spinRatio;
        const plannedDistance = targetTravelDistance(config, pullRatio);
        const launch: LaunchSnapshot = {
            directionX,
            directionY,
            pullRatio,
            targetTravelDistance: plannedDistance,
            initialSpeed,
            spinRatio,
            initialSpin,
        };

        this._aim.reset();
        if (!match.beginAim()) return;
        physics.beginTurn();
        physics.createLaunchIgnorePairs(disc, match.discs);
        if (match.applyCommittedShot({
            directionX,
            directionY,
            pullRatio,
            curveRatio: spinRatio,
        })) {
            this._lastLaunch = launch;
            this._debugMessage = `已发射：${(pullRatio * 100).toFixed(3)}%  ${angleDegrees.toFixed(3)}°  旋转 ${spinRatio.toFixed(3)}`;
        } else {
            match.cancelAim();
            this._debugMessage = '参数发射失败';
        }
    }

    private buildConfig(): ArcShotConfig {
        return {
            designWidth: this.designWidth, referenceHeight: this.referenceHeight,
            tableLeftX: this.tableLeftX, tableRightX: this.tableRightX,
            tableBottomY: this.tableBottomY, tableTopY: this.tableTopY,
            fireLineY: this.fireLineY, fireLineThickness: this.fireLineThickness,
            discRadius: this.discRadius, targetCenterX: this.targetCenterX, targetCenterY: this.targetCenterY,
            scoreRingRadii: [...this.scoreRingRadii], scoreValues: [...this.scoreValues],
            maxPullDistance: this.maxPullDistance, aimActivationDistance: this.aimActivationDistance,
            allowLaunchPointDrag: this.allowLaunchPointDrag,
            minimumFireRatio: this.minimumFireRatio,
            targetTravelDistanceMax: this.targetTravelDistanceMax,
            speedCalibrationDistance: this.speedCalibrationDistance,
            spinSliderOneWayTime: this.spinSliderOneWayTime,
            curvePeakProgress: this.curvePeakProgress,
            curveStartStrength: this.curveStartStrength,
            curveRiseExponent: this.curveRiseExponent,
            curveEnvelopeArea: this.curveEnvelopeArea,
            curveReferenceDistance: this.curveReferenceDistance,
            maxCurveHeadingDegrees: this.maxCurveHeadingDegrees,
            collisionSpinRetention: this.collisionSpinRetention,
            linearDeceleration: this.linearDeceleration, stopSpeed: this.stopSpeed,
            collisionRestitution: this.collisionRestitution,
            maxCollisionEventsPerMicrostep: this.maxCollisionEventsPerMicrostep,
            positionSlop: this.positionSlop, maxPositionIterations: this.maxPositionIterations,
            settlingTime: this.settlingTime,
        };
    }

    private captureConfigHash(): string { return JSON.stringify(this.buildConfig()); }

    private applyNetworkShot(command: ShotCommand): boolean {
        const match = this._match;
        const physics = this._physics;
        const config = this._config;
        const disc = match?.currentDisc;
        if (!match || !physics || !config || !disc) return false;
        this._aim.reset();
        physics.beginTurn();
        physics.createLaunchIgnorePairs(disc, match.discs);
        const applied = match.applyCommittedShot(command);
        if (applied) {
            const initialSpeed = initialSpeedForPullRatio(config, command.pullRatio);
            this._lastLaunch = {
                directionX: command.directionX,
                directionY: command.directionY,
                pullRatio: command.pullRatio,
                targetTravelDistance: targetTravelDistance(config, command.pullRatio),
                initialSpeed,
                spinRatio: command.curveRatio,
                initialSpin: command.curveRatio,
            };
        }
        return applied;
    }

    private loadNetworkCheckpoint(checkpoint: CheckpointV1): string {
        if (!this._match || !this._physics) throw new Error('GAME_NOT_READY');
        this._aim.reset();
        this._physics.reset();
        this._accumulator = 0;
        this._backlogFrames = 0;
        this._pressedUiTouchId = -1;
        this._pressedUi = null;
        this.resetReleaseTraceState(false);
        return this._match.loadCheckpoint(checkpoint);
    }

    private returnToPvpLobby(): void {
        this._aim.reset();
        this._physics?.reset();
        this._match?.restart();
        this._lastLaunch = null;
        this.resetReleaseTraceState(true);
        this._accumulator = 0;
        this._backlogFrames = 0;
        this._pressedUiTouchId = -1;
        this._pressedUi = null;
    }

    private spinSliderY(disc: DiscModel): number {
        return disc.y + disc.radius + 80;
    }

    private toCanvasPoint(event: EventTouch): Vec3 {
        const location = event.getUILocation();
        return this.ensureTransform(this.node).convertToNodeSpaceAR(new Vec3(location.x, location.y, 0));
    }

    private hitRect(x: number, y: number, centerX: number, centerY: number, width: number, height: number): boolean {
        return Math.abs(x - centerX) <= width * 0.5 && Math.abs(y - centerY) <= height * 0.5;
    }

    private bindResultButton(node: Node): void {
        if (this._boundResultButton === node) return;
        this._boundResultButton?.off(Node.EventType.TOUCH_END, this.onResultButtonTouchEnd, this);
        this._boundResultButton = node;
        node.on(Node.EventType.TOUCH_END, this.onResultButtonTouchEnd, this);
    }

    private onResultButtonTouchEnd(event: EventTouch): void {
        if (this._match?.state !== 'MATCH_RESULT') return;
        event.propagationStopped = true;
        this._pressedUiTouchId = -1;
        this._pressedUi = null;
        this.restartMatch();
    }

    private pressedUiContainsPoint(
        pressed: typeof this._pressedUi,
        x: number,
        y: number,
    ): boolean {
        if (pressed === 'RESTART') return this.hitRect(x, y, this._restartX, this._restartY, this._restartWidth, this._restartHeight);
        if (pressed === 'RESULT_RESTART') return this.hitRect(x, y, this._resultRestartX, this._resultRestartY, this._resultRestartWidth, this._resultRestartHeight);
        if (pressed === 'DEBUG_FIRE') return this.hitRect(x, y, this._debugFireX, this._debugFireY, this._debugFireWidth, this._debugFireHeight);
        if (pressed === 'PVP_MATCH') return this.hitRect(x, y, this._pvpMatchX, this._pvpControlY, 190, 58);
        if (pressed === 'PVP_LATENCY') return this.hitRect(x, y, this._pvpLatencyX, this._pvpControlY, 160, 58);
        if (pressed === 'PVP_DUP_COMMIT') return this.hitRect(x, y, this._pvpDuplicateX, this._pvpControlY, 210, 58);
        if (pressed === 'PVP_DESYNC') return this.hitRect(x, y, this._pvpDesyncX, this._pvpControlY, 210, 58);
        if (pressed === 'PVP_LEAVE') return this.hitRect(x, y, this._pvpLeaveX, this._pvpControlY, 140, 58);
        return false;
    }

    private setLabel(parent: Node, name: string, x: number, y: number, width: number, height: number, text: string, fontSize: number, color: Color, align = HorizontalTextAlignment.CENTER): Node {
        const node = this.ensureChild(parent, name, parent.children.length);
        this.configureLabel(node, x, y, width, height, text, fontSize, color, align);
        return node;
    }

    private ensureDebugEditBox(parent: Node, name: string, x: number, y: number, width: number, height: number, defaultValue: string): EditBox {
        const node = this.ensureChild(parent, name, parent.children.length);
        node.setPosition(x, y, 0);
        this.ensureTransform(node).setContentSize(width, height);
        let editBox = node.getComponent(EditBox);
        if (!editBox) {
            editBox = node.addComponent(EditBox);
            editBox.string = defaultValue;
            editBox.maxLength = 10;
            editBox.inputMode = 5; // EditBox.InputMode.DECIMAL：单行数值键盘。
        }
        // 复用 EditBox 自动创建的标准子节点；另建 Text/Placeholder 会让
        // 引擎自带标签与自定义标签同时显示，网页端会出现重复的大号数字。
        const textNode = this.ensureChild(node, 'TEXT_LABEL', 0);
        this.configureLabel(textNode, 0, 0, width - 16, height, editBox.string || defaultValue, 22, new Color(32, 43, 53, 255));
        editBox.textLabel = textNode.getComponent(Label);
        const placeholderNode = this.ensureChild(node, 'PLACEHOLDER_LABEL', 1);
        this.configureLabel(placeholderNode, 0, 0, width - 16, height, defaultValue, 22, new Color(120, 125, 130, 180));
        editBox.placeholderLabel = placeholderNode.getComponent(Label);
        editBox.placeholder = defaultValue;
        return editBox;
    }

    private configureLabel(node: Node, x: number, y: number, width: number, height: number, text: string, fontSize: number, color: Color, align = HorizontalTextAlignment.CENTER): void {
        node.setPosition(x, y, 0);
        this.ensureTransform(node).setContentSize(width, height);
        const label = node.getComponent(Label) ?? node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = Math.ceil(fontSize * 1.25);
        label.color = color;
        label.horizontalAlign = align;
        label.verticalAlign = align === HorizontalTextAlignment.LEFT ? VerticalTextAlignment.TOP : VerticalTextAlignment.CENTER;
    }

    private appendRect(graphics: Graphics, x: number, y: number, width: number, height: number, fill: Color, stroke?: Color, strokeWidth = 0): void {
        graphics.fillColor = fill;
        graphics.rect(x - width * 0.5, y - height * 0.5, width, height);
        graphics.fill();
        if (stroke && strokeWidth > 0) {
            graphics.strokeColor = stroke;
            graphics.lineWidth = strokeWidth;
            graphics.rect(x - width * 0.5, y - height * 0.5, width, height);
            graphics.stroke();
        }
    }

    private appendCircle(graphics: Graphics, x: number, y: number, diameter: number, fill: Color, stroke: Color, strokeWidth: number): void {
        graphics.fillColor = fill;
        graphics.circle(x, y, diameter * 0.5);
        graphics.fill();
        if (strokeWidth > 0) {
            graphics.strokeColor = stroke;
            graphics.lineWidth = strokeWidth;
            graphics.circle(x, y, diameter * 0.5);
            graphics.stroke();
        }
    }

    private ensureChild(parent: Node, name: string, siblingIndex: number): Node {
        let child = parent.getChildByName(name);
        if (!child) {
            child = new Node(name);
            child.layer = this.node.layer;
            parent.addChild(child);
        }
        child.setSiblingIndex(Math.min(siblingIndex, Math.max(0, parent.children.length - 1)));
        return child;
    }

    private removeChildIfPresent(parent: Node, name: string): void {
        const child = parent.getChildByName(name);
        if (!child) return;
        child.removeFromParent();
        child.destroy();
    }

    private ensureTransform(node: Node): UITransform { return node.getComponent(UITransform) ?? node.addComponent(UITransform); }
    private ensureGraphics(node: Node): Graphics { return node.getComponent(Graphics) ?? node.addComponent(Graphics); }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function nowMs(): number {
    return typeof performance !== 'undefined' && Number.isFinite(performance.now())
        ? performance.now()
        : Date.now();
}

function signed(value: number): string {
    if (!Number.isFinite(value)) return '--';
    return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function detectPvpMode(): boolean {
    if (EDITOR || typeof window === 'undefined') return false;
    try {
        return new URLSearchParams(window.location.search).get('pvp') === '1';
    } catch {
        return false;
    }
}
