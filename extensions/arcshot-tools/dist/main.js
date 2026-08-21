'use strict';

const FIRST_SCENE_UUID = 'df3d91c4-205b-4c5e-a9dc-c2f585715945';
const MAX_OPEN_ATTEMPTS = 5;
let openTimer = null;

async function openFirstScene(attempt = 1) {
    try {
        await Editor.Message.request('scene', 'open-scene', FIRST_SCENE_UUID);
        const currentScene = await Editor.Message.request('scene', 'query-current-scene');
        if (currentScene !== FIRST_SCENE_UUID) {
            throw new Error(`当前场景 UUID 不匹配：${currentScene}`);
        }
        console.log(`[ArcShot] GameScene 已打开：${currentScene}`);
    } catch (error) {
        if (attempt >= MAX_OPEN_ATTEMPTS) {
            console.error('[ArcShot] 无法自动打开 GameScene。', error);
            return;
        }
        openTimer = setTimeout(() => {
            void openFirstScene(attempt + 1);
        }, 1000);
    }
}

exports.methods = {
    openFirstScene() {
        return openFirstScene();
    },
};

exports.load = function load() {
    // 构建进程只负责编译，不应改变编辑器当前场景。
    if (process.argv.includes('--build')) {
        return;
    }
    openTimer = setTimeout(() => {
        void openFirstScene();
    }, 2000);
};

exports.unload = function unload() {
    if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
    }
};
