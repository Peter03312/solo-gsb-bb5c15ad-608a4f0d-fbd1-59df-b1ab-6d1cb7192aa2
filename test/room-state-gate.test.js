'use strict';

// 房间状态接纳门（RoomState）单元测试：
// 房间页每秒轮询与主持人控制并发时，先发出的旧查询可能在控制成功后才返回；离开房间
// （或加入另一房间）后旧响应也可能迟到。接纳门保证：只有【属于当前房间会话】且
// 【不早于已接纳状态】（先比修订号、同修订号再比服务端墙钟 server_wall）的响应才被
// 应用到视图与单调时钟锚点。
//
// 不能只比较修订号：自动启播、讨论停点/超载自动暂停、到末尾自动停住都不增加修订号，
// 同修订号内须按 server_wall 区分先后——成功控制后的状态不得被旧轮询回退，而同修订号
// 中更晚的合法自动状态仍须更新。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGate, watermarkOf, notOlder } = require('../public/roomstate.js');

const roomView = (over = {}) => ({
  code: 'ABC123',
  revision: 0,
  playing: false,
  server_wall: 1000,
  server_time: 0,
  speed: 1,
  ...over,
});

test('水位提取：修订号与服务端墙钟；缺墙钟时退到 -Infinity', () => {
  assert.deepEqual(watermarkOf(roomView({ revision: 3, server_wall: 2500 })), {
    revision: 3,
    serverWall: 2500,
  });
  assert.deepEqual(watermarkOf({ revision: 2 }), { revision: 2, serverWall: -Infinity });
  assert.deepEqual(watermarkOf(null), { revision: 0, serverWall: -Infinity });
});

test('notOlder：先比修订号，修订号相同再比墙钟（等墙钟也算不早于）', () => {
  const w = (revision, serverWall) => ({ revision, serverWall });
  assert.equal(notOlder(w(0, 1000), w(1, 900)), true); // 修订号更大，墙钟再早也更新
  assert.equal(notOlder(w(1, 1000), w(0, 9999)), false); // 旧修订号：墙钟再晚也不接纳
  assert.equal(notOlder(w(2, 1000), w(2, 1001)), true); // 同修订号：自动状态墙钟更晚
  assert.equal(notOlder(w(2, 1000), w(2, 1000)), true); // 同水位（乱序等价响应）幂等接纳
  assert.equal(notOlder(w(2, 1000), w(2, 999)), false); // 同修订号旧墙钟：迟到的旧轮询
});

test('初始视图建立首条水位，同等或更新的响应按序接纳', () => {
  const gate = createGate(roomView({ revision: 0, server_wall: 1000 }));
  assert.deepEqual(gate.getWatermark(), { revision: 0, serverWall: 1000 });
  assert.equal(gate.admit(roomView({ revision: 0, server_wall: 1001 })), true);
  assert.equal(gate.admit(roomView({ revision: 1, server_wall: 1002 })), true);
  assert.deepEqual(gate.getWatermark(), { revision: 1, serverWall: 1002 });
});

test('成功控制（修订号 +1）后迟到的旧轮询（修订号更小）被拒绝，不回退水位', () => {
  const gate = createGate(roomView({ revision: 0, server_wall: 1000 }));
  // t=1000 发出的轮询尚未返回；主持人先成功暂停（修订号 1，墙钟 1001）
  assert.equal(gate.admit(roomView({ revision: 1, server_wall: 1001, playing: false })), true);
  // 旧轮询此刻才返回：修订号 0、墙钟 1000 的旧快照——必须丢弃
  const stale = roomView({ revision: 0, server_wall: 1000, playing: true, server_time: 0 });
  assert.equal(gate.admit(stale), false);
  assert.deepEqual(gate.getWatermark(), { revision: 1, serverWall: 1001 });
});

test('同修订号不增修订号的自动状态：更晚墙钟（自动暂停/自动启播/到末尾）仍须接纳', () => {
  const gate = createGate(roomView({ revision: 5, server_wall: 2000, playing: true, server_time: 8 }));
  // 播放撞讨论停点在墙钟 2030 自动暂停（修订号仍为 5）
  const tripped = roomView({
    revision: 5,
    server_wall: 2030,
    server_time: 12,
    playing: false,
    stops: { points: [12], tripped: { time: 12 } },
  });
  assert.equal(gate.admit(tripped), true);
  assert.deepEqual(gate.getWatermark(), { revision: 5, serverWall: 2030 });
  // 自动启播：同修订号、墙钟更晚、playing 翻回 true，也必须接纳
  const started = roomView({ revision: 5, server_wall: 2100, playing: true, server_time: 12 });
  assert.equal(gate.admit(started), true);
  assert.deepEqual(gate.getWatermark(), { revision: 5, serverWall: 2100 });
  // 自动暂停前发出、更晚才返回的旧轮询（同修订号、墙钟更早、仍在播放）不得回退
  const latePoll = roomView({ revision: 5, server_wall: 2010, playing: true, server_time: 9 });
  assert.equal(gate.admit(latePoll), false);
  assert.deepEqual(gate.getWatermark(), { revision: 5, serverWall: 2100 });
});

test('响应乱序到达：修订号 1 先到、修订号 2 后到正常；再到修订号 1 被拒', () => {
  const gate = createGate(roomView({ revision: 0, server_wall: 100 }));
  assert.equal(gate.admit(roomView({ revision: 2, server_wall: 130 })), true);
  assert.equal(gate.admit(roomView({ revision: 1, server_wall: 120 })), false);
  assert.equal(gate.admit(roomView({ revision: 3, server_wall: 140 })), true);
  assert.deepEqual(gate.getWatermark(), { revision: 3, serverWall: 140 });
});

test('会话隔离：旧房间（含重新加入前的旧会话）迟到响应写不进新接纳门', () => {
  const oldGate = createGate(roomView({ code: 'AAA111', revision: 0, server_wall: 1000 }));
  const newGate = createGate(roomView({ code: 'BBB222', revision: 0, server_wall: 5000 }));

  // 离开房间 A、加入房间 B 后，A 的在途轮询才返回：携带的是 A 的旧门身份
  const oldResponse = roomView({ code: 'AAA111', revision: 4, server_wall: 9999 });
  assert.equal(oldGate.admit(oldResponse), true); // 旧门自身仍可推进（不影响任何人，已无人引用）
  assert.equal(newGate.admit(oldResponse, oldGate), false); // 用旧门身份投递给新门：拒绝
  assert.equal(newGate.belongs(oldGate), false);
  assert.equal(newGate.belongs(newGate), true);
  assert.deepEqual(newGate.getWatermark(), { revision: 0, serverWall: 5000 });

  // 重新加入同一房间也会换门：旧会话响应即使修订号更大也不得写入
  const rejoinGate = createGate(roomView({ code: 'AAA111', revision: 4, server_wall: 10_000 }));
  assert.equal(rejoinGate.admit(oldResponse, oldGate), false);
  assert.deepEqual(rejoinGate.getWatermark(), { revision: 4, serverWall: 10_000 });
});

test('缺 server_wall 的异常响应：不压过已有有效水位', () => {
  const gate = createGate(roomView({ revision: 1, server_wall: 1000 }));
  assert.equal(gate.admit({ revision: 1 }), false);
  assert.deepEqual(gate.getWatermark(), { revision: 1, serverWall: 1000 });
});

test('无初始视图创建的门：首条正常响应即可建立水位', () => {
  const gate = createGate();
  assert.equal(gate.admit(roomView({ revision: 0, server_wall: 1 })), true);
  assert.deepEqual(gate.getWatermark(), { revision: 0, serverWall: 1 });
});
