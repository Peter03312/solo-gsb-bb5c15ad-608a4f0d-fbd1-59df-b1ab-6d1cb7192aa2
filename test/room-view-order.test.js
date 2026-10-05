'use strict';

// 共享房间状态接纳顺序（RoomView）单元测试：
// 只有「属于当前房间会话、且按 (revision, server_wall) 偏序不早于已接纳状态」的
// 响应才允许应用到视图与单调时钟锚点。修订号更大必为更新；修订号相同再比服务端
// 墙钟——自动启播、讨论停点/超载自动暂停、到末尾都不增修订号，同修订号下较新的
// 合法自动状态仍须更新，迟到旧轮询（含成功控制后的旧回包）必须拒绝。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sameRoomCode, isAtLeastAsFresh, canApply } = require('../public/roomview.js');

const v = (rev, wall, over = {}) => ({ code: 'K7P2QX', revision: rev, server_wall: wall, ...over });

test('sameRoomCode：仅房间码完全一致才属于当前房间', () => {
  assert.equal(sameRoomCode(v(0, 1000), 'K7P2QX'), true);
  assert.equal(sameRoomCode(v(0, 1000), 'OTHER1'), false);
  assert.equal(sameRoomCode(null, 'K7P2QX'), false);
  assert.equal(sameRoomCode({}, 'K7P2QX'), false);
  assert.equal(sameRoomCode({ code: undefined }, undefined), true); // 非常规但严格相等
});

test('尚无已接纳状态（刚进入房间）：首个响应一律接纳', () => {
  assert.equal(isAtLeastAsFresh(v(0, 1000), null), true);
});

test('修订号更大：一定更新（即使它是迟到回包，也携带更新的修订）', () => {
  // 已接纳旧修订号 + 更早墙钟（常规）
  assert.equal(isAtLeastAsFresh(v(2, 1005), v(1, 1010)), true);
  // 极端乱序：新修订号的墙钟读数更小（不应靠墙钟把它挡掉）
  assert.equal(isAtLeastAsFresh(v(3, 1000), v(2, 5000)), true);
});

test('修订号更小：一定是旧响应，拒绝（成功控制后的状态不得被旧轮询回退）', () => {
  // 主持人成功控制：revision 1->2；控制前发出、墙钟更晚返回的旧轮询（revision 1）
  // 哪怕墙钟读数更大，也绝不能覆盖新修订号与新校时锚点
  assert.equal(isAtLeastAsFresh(v(1, 1099), v(2, 1000)), false);
  assert.equal(isAtLeastAsFresh(v(0, 9999), v(1, 1)), false);
});

test('同修订号：以 server_wall 区分新旧自动状态（不增修订号的状态迁移）', () => {
  // 自动启播 / 讨论停点自动暂停 / 超载边界自动暂停 / 惰性落库到末尾
  // —— 修订号不变、墙钟更晚：合法的较新自动状态，必须接纳
  const pausedAtStop = v(2, 1005, { playing: false, server_time: 12 });
  const before = v(2, 1000, { playing: true, server_time: 7 });
  assert.equal(isAtLeastAsFresh(pausedAtStop, before), true);
  // 反向：先生成的旧轮询（同修订号、墙钟更早）在控制成功后的同修订响应之后才回来
  // —— 这里已接纳状态本身就是同修订号自动状态，旧包必须拒绝
  assert.equal(isAtLeastAsFresh(before, pausedAtStop), false);
});

test('同修订号且同墙钟：视为同样新鲜，幂等接纳（锚点数值不变）', () => {
  assert.equal(isAtLeastAsFresh(v(2, 1000, { playing: false }), v(2, 1000, { playing: true })), true);
});

test('轮询失败不经过接纳：恢复后的较新响应正常接纳、更旧仍拒绝', () => {
  // 最近有效状态保留在已接纳锚点；恢复后服务端已推进
  const lastGood = v(1, 1000, { playing: true });
  assert.equal(isAtLeastAsFresh(v(1, 1003, { server_time: 13 }), lastGood), true);
  // 恢复请求若异常地返回更旧快照：不回退
  assert.equal(isAtLeastAsFresh(v(1, 999), lastGood), false);
});

test('换房间会话：新房间首响应与旧房间互不接纳（由 sameRoomCode 把关）', () => {
  const roomA = { code: 'AAAAAA', revision: 9, server_wall: 9999 };
  const roomB = { code: 'BBBBBB', revision: 0, server_wall: 1 };
  // 离开 A 后加入 B：A 的迟到响应不属于 B
  assert.equal(sameRoomCode(roomA, roomB.code), false);
  // B 自己的响应属于 B（joinId 代次由 app 层另行隔离同房间码重进）
  assert.equal(sameRoomCode(roomB, 'BBBBBB'), true);
});

test('非对象或缺 server_wall 的异常响应不能作为锚点', () => {
  assert.equal(isAtLeastAsFresh(null, v(0, 1)), false);
  assert.equal(isAtLeastAsFresh('x', v(0, 1)), false);
  assert.equal(isAtLeastAsFresh({ revision: 0 }, v(0, 1)), false);
  // 已接纳锚点缺墙钟（正常不会发生）：信任带墙钟的新响应
  assert.equal(isAtLeastAsFresh(v(0, 2), { revision: 0 }), true);
});

test('canApply：会话代次一致、房间码一致且更新鲜才接纳（轮询/控制回包乱序）', () => {
  const accepted = v(2, 1000);
  const session = { code: 'K7P2QX', joinId: 7 };
  // 常规：较新轮询接纳
  assert.equal(canApply(v(2, 1001), accepted, session, 7), true);
  // 成功控制后的旧轮询回包（修订号更小）：拒绝，新修订号/锚点不被回退
  assert.equal(canApply(v(1, 1099), accepted, session, 7), false);
  // 同修订号但更早墙钟（自动状态之前生成的旧包）：拒绝
  assert.equal(canApply(v(2, 999), accepted, session, 7), false);
});

test('canApply：离开房间后旧响应一律丢弃（joinId 已递增）', () => {
  const accepted = v(1, 1000);
  const oldSession = { code: 'K7P2QX', joinId: 7 };
  // 离开后又重新加入【同一房间码】，会话代次变为 8：旧在途响应即使更新鲜也不得接纳
  assert.equal(canApply(v(5, 9999), accepted, oldSession, 8), false);
  // 缺少会话信息（如离开后 state.room 已不存在）：拒绝
  assert.equal(canApply(v(1, 1001), accepted, null, 8), false);
});

test('canApply：重新加入另一房间后，旧房间迟到响应不得写进新房间', () => {
  // 场景：离开 A（AAAAAA）加入 B（BBBBBB）；A 的迟到轮询带着 A 的房间码与很高修订号返回
  const roomBView = { code: 'BBBBBB', revision: 0, server_wall: 1 };
  const sessionA = { code: 'AAAAAA', joinId: 3 };
  const lateA = { code: 'AAAAAA', revision: 42, server_wall: 9_999_999, playing: true };
  assert.equal(canApply(lateA, roomBView, sessionA, 4), false); // 代次与房间码都不符

  // 新房间 B 自己的响应：正常接纳
  const sessionB = { code: 'BBBBBB', joinId: 4 };
  assert.equal(canApply({ ...roomBView, server_wall: 2 }, roomBView, sessionB, 4), true);
});
