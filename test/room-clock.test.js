'use strict';

// 共享房间观看端校时（RoomClock）单元测试：
// 以服务端状态的 server_wall/server_time 为基准，两次同步之间只按本机单调时钟
// 实际流逝推进——设备墙钟偏快/偏慢（同步时设备与服务端有偏差）或观看途中设备墙钟
// 被调整，都不得影响推算出的时码与服务端墙钟估计；暂停恒为基准时码；轮询失败
// 沿用最近一次有效锚点；恢复同步后重新校准。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createClock } = require('../public/roomclock.js');

// 可控时钟源：mono 模拟本机单调时钟（永不回跳）；wall 模拟设备墙钟（可被人为
// 调到任意值，RoomClock 一律不得使用它）。
function fakeClocks(startMono = 1000, startWall = 10_000_000) {
  const c = { mono: startMono, wall: startWall };
  return {
    clock: c,
    monoNow: () => c.mono,
    deviceNow: () => c.wall,
    tick(sec) {
      c.mono += sec;
      c.wall += sec;
    },
    // 模拟观看途中设备墙钟被调整（单调时钟照常均匀前进）
    shiftDeviceWall(delta) {
      c.wall += delta;
    },
  };
}

const view = (over = {}) => ({
  server_wall: 1000,
  server_time: 10,
  speed: 1,
  playing: true,
  ...over,
});

test('未同步前 currentTime/serverWallNow 为 null，isPlaying 为 false', () => {
  const f = fakeClocks();
  const clk = createClock(f.monoNow);
  assert.equal(clk.currentTime(), null);
  assert.equal(clk.serverWallNow(), null);
  assert.equal(clk.isPlaying(), false);
  assert.equal(clk.elapsed(), 0);
});

test('播放中：按单调流逝 × 倍速推进时码，不读设备墙钟', () => {
  const f = fakeClocks(5000, 9_999_999); // 设备墙钟与服务端差几百万秒也无所谓
  const clk = createClock(f.monoNow);
  clk.sync(view({ server_wall: 2000, server_time: 30, speed: 1, playing: true }));
  f.tick(10);
  assert.ok(Math.abs(clk.currentTime() - 40) < 1e-9);
  assert.ok(Math.abs(clk.serverWallNow() - 2010) < 1e-9);
  f.tick(5);
  assert.ok(Math.abs(clk.currentTime() - 45) < 1e-9);
});

test('倍速 0.5/2：时码按单调流逝 × speed 推进', () => {
  const f = fakeClocks();
  const clk = createClock(f.monoNow);
  clk.sync(view({ speed: 2 }));
  f.tick(4);
  assert.ok(Math.abs(clk.currentTime() - 18) < 1e-9);

  clk.sync(view({ speed: 0.5, server_wall: 1010, server_time: 18, playing: true }));
  f.tick(8);
  assert.ok(Math.abs(clk.currentTime() - 22) < 1e-9);
});

test('暂停锚点：恒为基准时码，单调流逝不外推', () => {
  const f = fakeClocks();
  const clk = createClock(f.monoNow);
  clk.sync(view({ playing: false, server_time: 42 }));
  f.tick(60);
  assert.equal(clk.currentTime(), 42);
  // 服务端墙钟估计仍随单调流逝推进（倒计时需要）
  assert.ok(Math.abs(clk.serverWallNow() - 1060) < 1e-9);
  assert.equal(clk.isPlaying(), false);
});

test('设备墙钟在观看途中被拨快/拨慢：时码与墙钟估计完全不受影响', () => {
  const f = fakeClocks();
  const clk = createClock(f.monoNow);
  clk.sync(view({ server_wall: 1000, server_time: 10, speed: 1, playing: true }));
  f.tick(10);
  assert.ok(Math.abs(clk.currentTime() - 20) < 1e-9);
  // 用户把设备时钟向前拨 5 分钟、再向后拨 11 分钟：单调时钟只走了真实的 2 秒
  f.shiftDeviceWall(300);
  f.tick(1);
  f.shiftDeviceWall(-660);
  f.tick(1);
  assert.ok(Math.abs(clk.currentTime() - 22) < 1e-9);
  assert.ok(Math.abs(clk.serverWallNow() - 1012) < 1e-9);
});

test('设备墙钟先天偏差（快五分钟/慢五分钟）：同步后推进仍准确', () => {
  for (const bias of [300, -300]) {
    const f = fakeClocks(800, 1000 + bias); // 设备 wall 与 mono 基准无任何换算关系
    const clk = createClock(f.monoNow);
    clk.sync(view({ server_wall: 5000, server_time: 0, speed: 1, playing: true }));
    f.tick(30);
    assert.ok(Math.abs(clk.currentTime() - 30) < 1e-9, `bias=${bias}`);
    assert.ok(Math.abs(clk.serverWallNow() - 5030) < 1e-9, `bias=${bias}`);
  }
});

test('轮询暂时失败：沿用最近一次有效锚点按单调流逝继续；恢复后重新校准', () => {
  const f = fakeClocks();
  const clk = createClock(f.monoNow);
  clk.sync(view({ server_wall: 1000, server_time: 10, playing: true }));
  f.tick(3);
  assert.ok(Math.abs(clk.currentTime() - 13) < 1e-9);
  // 期间没有任何 sync（模拟轮询连续失败）：继续按旧锚点推进
  f.tick(4);
  assert.ok(Math.abs(clk.currentTime() - 17) < 1e-9);
  assert.equal(clk.getAnchor().wall, 1000);
  // 轮询恢复：服务端真实进度（比如期间被他人暂停在 16）重新锚定
  clk.sync(view({ server_wall: 1007, server_time: 16, playing: false }));
  f.tick(5);
  assert.equal(clk.currentTime(), 16);
  assert.ok(Math.abs(clk.serverWallNow() - 1012) < 1e-9);
});

test('重新同步即新基准（服务端纠偏：本地曾外推过头会被拉回）', () => {
  const f = fakeClocks();
  const clk = createClock(f.monoNow);
  clk.sync(view({ server_wall: 1000, server_time: 10, playing: true }));
  f.tick(30); // 本地外推到 40，但服务端在 12 秒处撞到讨论停点暂停
  assert.ok(Math.abs(clk.currentTime() - 40) < 1e-9);
  clk.sync(view({ server_wall: 1030, server_time: 12, playing: false }));
  assert.equal(clk.currentTime(), 12);
  f.tick(10);
  assert.equal(clk.currentTime(), 12); // 暂停后不再外推
});

test('单调时钟不回跳：注入时刻早于锚点时流逝按 0 计', () => {
  const clk = createClock();
  clk.sync(view(), 100); // 显式指定同步时的单调时刻
  assert.equal(clk.elapsed(40), 0);
  assert.equal(clk.currentTime(40), 10);
});

test('预约/凭证倒计时口径：到期墙钟 − 服务端墙钟估计，随单调流逝归零', () => {
  const f = fakeClocks();
  const clk = createClock(f.monoNow);
  clk.sync(view({ playing: false, server_wall: 1000, server_time: 8 }));
  const startAt = 1300; // 预约 5 分钟后启播
  f.tick(120);
  assert.ok(Math.abs(startAt - clk.serverWallNow() - 180) < 1e-9);
  f.tick(180);
  assert.equal(startAt - clk.serverWallNow(), 0);
  f.tick(60);
  // 到点后倒计时由调用方夹到 0；墙钟估计继续走
  assert.ok(clk.serverWallNow() > startAt);
  assert.equal(Math.max(0, startAt - clk.serverWallNow()), 0);
});
