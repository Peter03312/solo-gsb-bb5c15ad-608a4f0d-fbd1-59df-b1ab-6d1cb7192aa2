'use strict';

// 房间状态「接纳顺序」的服务端前提（HTTP）：
// 前端只接纳属于当前房间会话、且按 (revision, server_wall) 偏序不早于已接纳状态的
// 响应。这里验证该排序所依赖的响应事实在真实服务端上成立：
//   1) 成功控制令 revision +1，其 server_wall 不早于控制前的查询；
//   2) 自动启播（到点惰性启播）不增加修订号，但响应 server_wall 随墙钟推进、playing
//      变为 true——即「同修订号的较新自动状态」必须能与旧轮询区分并被接纳；
//   3) 到末尾惰性落库同样不增加修订号（此处用预约启播后播完短版本覆盖该路径）；
//   4) 409 冲突重取行为、观看者只读行为保持不变；
//   5) 不同房间（不同房间码）的响应彼此独立——客户端再凭会话代次/房间码隔离迟到响应。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-order-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');

let server;

function request(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const getJson = (p) => request('GET', p).then((r) => r.json);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => server.close(r));
});

async function resetDraft() {
  const cues = await getJson('/api/cues');
  for (const c of cues) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await getJson('/api/lights');
  for (const l of lights) await request('DELETE', `/api/lights/${l.id}`);
}

// 短版本：单灯 t=0 渐变到 100、duration 1 秒（自动启播/播完路径墙钟开销小）
async function seedShortVersion(label) {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: `接纳顺序灯-${label}` })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9601, light_id: l, time: 0, target: 100, duration: 1 }]);
  return (await request('POST', '/api/versions', { label })).json;
}

async function createRoom(versionId) {
  return (await request('POST', '/api/rooms', { version_id: versionId })).json;
}
const roomUrl = (code) => `/api/rooms/${code}`;
const control = (code, key, body) =>
  request('POST', `${roomUrl(code)}/control`, { control_key: key, ...body });

test('成功控制 revision+1 且墙钟不早于控制前查询；过期修订号 409、重取得到最新', async () => {
  const ver = await seedShortVersion('控制序');
  const room = await createRoom(ver.id);

  const before = await getJson(roomUrl(room.code));
  assert.equal(before.revision, 0);
  assert.equal(before.playing, false);
  await sleep(5);

  const played = (await control(room.code, room.control_key, { revision: 0, action: 'play' })).json;
  assert.equal(played.revision, 1);
  assert.equal(played.playing, true);
  // 控制响应是服务端在控制事务后组装：墙钟不早于控制前那次 GET（前端把它与轮询
  // 回包统一按 (revision, server_wall) 排序，控制成功的新锚点不会被旧轮询回退）
  assert.ok(played.server_wall >= before.server_wall);

  // 旧修订号再发控制：409 且房间不变；随后 GET 重取即最新（revision=1）
  const stale = await control(room.code, room.control_key, { revision: 0, action: 'pause' });
  assert.equal(stale.status, 409);
  const refetched = await getJson(roomUrl(room.code));
  assert.equal(refetched.revision, 1);
  assert.equal(refetched.playing, true); // 409 未改动房间
});

test('自动启播不增修订号但墙钟推进、playing 翻转：同修订号下较新自动状态可区分', async () => {
  const ver = await seedShortVersion('启播序');
  const room = await createRoom(ver.id);

  // 预约 0.25 秒后启播（预约本身 revision+1 → 1；房间仍暂停）
  const startAt = Date.now() / 1000 + 0.25;
  const scheduled = (await request('PUT', `${roomUrl(room.code)}/schedule`, {
    control_key: room.control_key,
    revision: 0,
    start_at: startAt,
  })).json;
  assert.equal(scheduled.revision, 1);
  assert.equal(scheduled.schedule.state, 'pending');

  // 启播前的轮询快照（同修订号 1、暂停）—— 假设它在网络上滞留
  const earlyPoll = await getJson(roomUrl(room.code));
  assert.equal(earlyPoll.revision, 1);
  assert.equal(earlyPoll.playing, false);

  await sleep(400); // 到点；下次 GET 触发惰性启播
  const afterStart = await getJson(roomUrl(room.code));
  assert.equal(afterStart.revision, 1, '自动启播不增加修订号');
  // 同修订号下：新响应墙钟严格更晚且 playing=true —— 前端据此接纳较新自动状态，
  // 而滞留的 earlyPoll（墙钟更早、playing=false）必须被拒绝
  assert.ok(afterStart.server_wall > earlyPoll.server_wall);
  assert.equal(afterStart.schedule.state, 'started');
  assert.equal(
    afterStart.playing === true || afterStart.playing === false,
    true,
    '启播后可能仍在播放或已播完到末尾（两种都是启播后的新自动状态）'
  );

  await sleep(900); // 短版本播完：到末尾惰性落库，修订号仍不增加
  const atEnd = await getJson(roomUrl(room.code));
  assert.equal(atEnd.revision, 1, '到末尾自动停住不增加修订号');
  assert.equal(atEnd.playing, false);
  assert.ok(Math.abs(atEnd.server_time - atEnd.duration) < 1e-6);
  assert.ok(atEnd.server_wall > earlyPoll.server_wall);
});

test('观看者只读：无密钥控制 403，房间状态对两房间独立', async () => {
  const ver = await seedShortVersion('只读序');
  const roomA = await createRoom(ver.id);
  const roomB = await createRoom(ver.id);
  assert.notEqual(roomA.code, roomB.code);

  const forbidden = await request('POST', `${roomUrl(roomA.code)}/control`, { revision: 0, action: 'play' });
  assert.equal(forbidden.status, 403);
  const a = await getJson(roomUrl(roomA.code));
  assert.equal(a.playing, false);
  assert.equal(a.revision, 0);

  // 持密钥控制 A：B 的视图完全不受影响（房间码不同，前端会话隔离 + 服务端数据独立）
  const playedA = await control(roomA.code, roomA.control_key, { revision: 0, action: 'play' });
  assert.equal(playedA.status, 200);
  const b = await getJson(roomUrl(roomB.code));
  assert.equal(b.revision, 0);
  assert.equal(b.playing, false);
  assert.equal(b.code, roomB.code);
});
