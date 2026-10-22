/**
 * 背景音乐管理 —— 巅峰对决时播放王者荣耀《冠军杯》
 *
 * 版权说明：《冠军杯》为腾讯版权音乐，本游戏**不内置**任何音频文件。
 * 播放器会尝试加载本地音频文件（按下面 SOURCES 顺序查找），找到就自动播放；
 * 找不到则静默跳过，不影响游戏。玩家可自行把《冠军杯》mp3 放到对应路径。
 *
 * 浏览器自动播放限制：播放必须在用户手势（点击）触发的同步调用里发起，
 * 因此巅峰对决音乐在 renderLineupPause 被点击"推进"同步渲染时触发，可正常出声。
 */

const SOURCES = [
  'assets/bgm_champion.mp3',
  'bgm_champion.mp3',
  'assets/冠军杯.mp3',
];

let audio = null;
let enabled = true;      // 是否开启背景音乐
let hasFile = null;      // 缓存：是否成功加载过音频文件

function ensure() {
  if (audio) return audio;
  if (typeof Audio === 'undefined') return null;   // 非浏览器环境（测试）
  audio = new Audio();
  audio.loop = true;
  audio.volume = 0.45;
  return audio;
}

/** 巅峰对决开场：播放《冠军杯》音乐（找不到文件则静默） */
export function playPeakBgm() {
  if (!enabled) return;
  const a = ensure();
  if (!a) return;
  try {
    // 依次尝试几个可能的本地路径，直到某个能加载
    let idx = 0;
    const tryNext = () => {
      if (idx >= SOURCES.length) return;
      a.src = SOURCES[idx++];
      a.play()
        .then(() => { hasFile = true; })
        .catch(() => { if (hasFile === null) tryNext(); });
    };
    if (hasFile === null) tryNext();
    else a.play().catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/** 停止背景音乐（离开巅峰对决时调用） */
export function stopBgm() {
  if (audio) {
    try { audio.pause(); audio.currentTime = 0; } catch (e) { /* 忽略 */ }
  }
}

/** 切换背景音乐开关，返回当前状态 */
export function toggleBgm() {
  enabled = !enabled;
  if (!enabled) stopBgm();
  return enabled;
}

/** 当前是否开启背景音乐 */
export function bgmEnabled() { return enabled; }
