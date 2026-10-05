/*
 * 共享房间状态接纳门（纯逻辑，无 DOM 依赖）
 * 浏览器与 Node 共用：浏览器挂到 window.RoomState，Node 通过 module.exports 引入。
 *
 * 背景：房间页每秒轮询，主持人的控制（播放/暂停/跳转/改速/编排/停点/预约/交接）与
 * 轮询并发时，请求返回顺序不保证与生成顺序一致：
 *   1) 先发出的旧查询若在一次成功控制之后才返回，其携带的旧修订号状态会覆写刚拿到的
 *      新修订号，单调时钟锚点也跟着回退，舞台与倒计时被旧快照拽回；
 *   2) 离开房间（或加入另一房间）后才返回的旧响应，可能写进刚加入的新房间会话。
 * 修复：每次「进入房间」建立一个独立的接纳门，只把【属于当前房间会话】且【不早于
 * 已接纳状态】的响应应用到视图与 RoomClock 校时锚点；其余响应一律丢弃。
 *
 * 为什么不能只比较修订号：自动启播、讨论停点自动暂停、超载边界自动暂停以及到末尾
 * 自动停住都【不增加修订号】。因此同修订号内必须再按响应自带的服务端墙钟 server_wall
 * 判定先后：修订号更晚（元组序）的响应才算更新；成功控制（修订号 +1）之后到达的旧
 * 轮询响应（修订号更小）永不回退视图，而同修订号中墙钟更晚的合法自动状态仍会更新。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RoomState = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 状态水位：{ revision, serverWall }。响应缺少墙钟（异常/旧格式）时退到 -Infinity，
  // 即同修订号下只可能被墙钟更新的响应接纳、绝不压过已接纳的有效水位。
  function watermarkOf(view) {
    const rawWall = view ? view.server_wall : undefined;
    const rawRev = view ? view.revision : undefined;
    const wall = rawWall == null ? NaN : Number(rawWall);
    const rev = rawRev == null ? NaN : Number(rawRev);
    return {
      revision: Number.isFinite(rev) ? rev : 0,
      serverWall: Number.isFinite(wall) ? wall : -Infinity,
    };
  }

  /**
   * 水位先后判定：b 是否不早于 a。
   * 先比修订号（任何成功控制都令修订号 +1，更大的修订号必为更晚的服务端状态），
   * 修订号相同再比服务端墙钟（自动状态不增修订号，只靠墙钟区分先后）。
   */
  function notOlder(a, b) {
    if (b.revision !== a.revision) return b.revision > a.revision;
    return b.serverWall >= a.serverWall;
  }

  /**
   * 房间会话接纳门：进入房间（enterRoom）时新建一个；离开/重新加入后旧门随会话丢弃。
   * admit(view) 仅当响应属于本门（本房间会话）且水位不早于已接纳水位时返回 true，
   * 并把水位推进到该响应；否则返回 false（调用方必须丢弃该响应，不动视图与校时锚点）。
   */
  function createGate(initialView) {
    // 每个门实例即一个房间会话身份：离开房间后仍在途的旧响应持有的是旧门，
    // 与新房间（或重新加入后）的新门不是同一对象，直接拒之门外。
    let watermark = watermarkOf(initialView || {});

    function belongs(sessionGate) {
      return sessionGate === gate;
    }

    function admit(view, sessionGate = gate) {
      if (sessionGate !== gate) return false;
      const next = watermarkOf(view || {});
      if (!notOlder(watermark, next)) return false;
      watermark = next;
      return true;
    }

    // 当前已接纳水位（测试与诊断用）
    function getWatermark() {
      return { revision: watermark.revision, serverWall: watermark.serverWall };
    }

    const gate = { admit, belongs, getWatermark };
    return gate;
  }

  return { createGate, watermarkOf, notOlder };
});
