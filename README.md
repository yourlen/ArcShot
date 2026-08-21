# ArcShot

ArcShot 是面向微信小游戏与抖音小游戏的 Cocos Creator 3.8.8 竖屏 2D 项目。

## 当前版本

当前实现对应《ArcShot 本地双阵营可玩原型开发规格 v0.3》，并保留已确认的扁平三层视觉结构：

- 顶层视觉节点仍为 `SolidBackground`、`Table`、`TableItems`；
- 红蓝各4枚圆盘，固定按 `R1→B1→R2→B2→R3→B3→R4→B4` 发射；
- READY 发球点横移可开关；当前试玩暂时关闭，每回合从发球线中央发射；
- 旋转滑块在 `-1～+1` 之间自动往复，正旋右弯、负旋左弯；
- 物理使用 60Hz 逻辑帧和每帧4个 `1/240s` 全场微步；
- 圆盘碰撞和左/右/上开放边界共用TOI事件时间线；
- 桌面下方不触发OUT，向下移动仍按摩擦自然停止；
- 支持发球重叠豁免、连续碰撞、位置修正和事件上限安全停止；
- 每回合停稳后重算五圈得分，第8盘后显示胜负和重新开始；
- 参数均集中显示在 `Canvas` 的 `ArcShotSceneLayout` Inspector 中。

## 代码结构

```text
assets/scripts/core/ArcShotConfig.ts      集中参数、固定时间常量和校验
assets/scripts/core/DiscModel.ts          圆盘数据、阵营与状态
assets/scripts/core/AimController.ts      发球线横移、瞄准、力度和旋转滑块
assets/scripts/core/PhysicsWorld.ts       微步、弧线、CCD、碰撞、边界和豁免
assets/scripts/core/MatchController.ts    8回合、计分、结算和重开
assets/scripts/layout/ArcShotSceneLayout.ts Cocos输入、绘制、UI和系统组装
tools/verify_v02.ts                       纯数值自动验证
```

## 默认手感参数

```text
圆盘半径：45
最大初速度：1755
线速度减速：650
停止阈值：45
最大旋转：1.0
旋转转侧向系数：1800
旋转减速度：0.55/秒
碰撞恢复系数：0.20
```

75%纯直线默认约在1.96秒停在靶心附近；50%力度停在发球线与靶心之间，满力度保留越过靶区和出桌风险。

## 打开工程

使用 Cocos Creator 3.8.8 打开本目录，然后打开 `assets/scenes/GameScene.scene`。如果编辑器正在运行旧预览，停止后重新预览以导入新的 `core` 模块。

## 数值验证

`tools/verify_v02.ts` 覆盖直线落点、正负旋转对称、碰撞响应、高速CCD、三侧OUT、发球豁免、计分、8回合结算和完整重置。
