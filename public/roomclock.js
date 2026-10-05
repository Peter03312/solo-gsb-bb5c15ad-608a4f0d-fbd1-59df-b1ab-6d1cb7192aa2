/*
 * 共享房间观看端校时模块（纯逻辑，无 DOM 依赖）
 * 浏览器与 Node 共用：浏览器挂到 window.RoomClock，Node 通过 module.exports 引入。
 *
 * 背景：共享房间跨设备观看时，页面不能用「设备本地墙钟 − 服务端墙钟」外推进度，
 * 否则设备墙钟快五分钟会把仍在播放的舞台直接推到版本末尾，慢五分钟会停在旧时码，
 * 预约启播倒计时与交接凭证倒计时也会随设备时钟失真。
 *
 * 做法：以房间状态响应自带的服务端墙钟 server_wall 与对应时码 server_time 为基准，
 * 两次同步之间只用【本机单调时钟实际流逝的时间】推进（performance.now() 不受墙钟
 * 被人工调整、NTP 跳变影响）：
 *   演出时码 = server_time + max(0, 单调流逝秒) × speed（暂停时恒为 server_time）
 *   服务端墙钟估计 = server_wall + max(0, 单调流逝秒)（预约/凭证倒计时据此换算）
 * 设备墙钟原有偏差、或观看途中被调整，都不影响推算；下一次轮询/控制响应到达即重新
 * 校准锚点。轮询暂时失败时沿用最近一次有效锚点继续展示，恢复后的响应自动重新校时。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RoomClock = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 本机单调时钟（秒）：浏览器与 Node ≥20 均提供 performance.now()；
  // 极端环境缺失时退回 Date.now()（仍可运行，只是重新暴露于墙钟跳变）。
  function defaultMonoNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now() / 1000;
    }
    return Date.now() / 1000;
  }

  /**
   * 校时钟：每次成功的房间状态同步（轮询 / 控制 / 编排 / 交接响应）后调用
   * sync(view) 重新锚定；渲染帧用 currentTime() / serverWallNow() 取推算值。
   * 构造参数 monoNow 可注入，便于测试模拟设备墙钟跳变与时间流逝。
   */
  function createClock(monoNow = defaultMonoNow) {
    // 最近一次有效同步锚点：{ wall, time, speed, playing, mono }
    // wall/time 同为服务端口径（server_wall/server_time）；mono 为收到该响应时
    // 的本机单调时刻。尚未成功同步前为 null（房间页进入时必有初始状态）。
    let anchor = null;

    function sync(view, mono = monoNow()) {
      anchor = {
        wall: view.server_wall,
        time: view.server_time,
        speed: view.speed,
        playing: !!view.playing,
        mono,
      };
      return anchor;
    }

    // 距最近一次同步实际流逝的单调秒数（不为负：标签页挂起恢复等场景下
    // performance.now() 单调递增，负值只可能来自注入异常）。
    function elapsed(mono = monoNow()) {
      if (!anchor) return 0;
      return Math.max(0, mono - anchor.mono);
    }

    // 当前服务端墙钟估计：仅按单调流逝推进，与设备墙钟偏差/调整无关。
    function serverWallNow(mono = monoNow()) {
      if (!anchor) return null;
      return anchor.wall + elapsed(mono);
    }

    /**
     * 当前演出时码（线性，不含循环排演映射与停点/超载/末尾截停，那些由页面
     * 与服务端同规则处理）：
     *  - 尚未同步：null（进入房间必先拿到状态，正常不会走到）；
     *  - 暂停锚点：恒为基准时码；
     *  - 播放锚点：基准时码 + 单调流逝 × 倍速（不向回走）。
     */
    function currentTime(mono = monoNow()) {
      if (!anchor) return null;
      if (!anchor.playing) return anchor.time;
      return anchor.time + elapsed(mono) * anchor.speed;
    }

    // 最近一次有效同步时的播放状态（轮询失败期间沿用）
    function isPlaying() {
      return !!anchor && anchor.playing;
    }

    function getAnchor() {
      return anchor;
    }

    return { sync, elapsed, serverWallNow, currentTime, isPlaying, getAnchor };
  }

  return { createClock, defaultMonoNow };
});
