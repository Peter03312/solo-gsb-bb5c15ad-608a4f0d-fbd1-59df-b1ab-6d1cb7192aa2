/*
 * 共享房间状态接纳顺序（纯逻辑，无 DOM 依赖）：浏览器与 Node 共用。
 * 浏览器挂到 window.RoomView，Node 通过 module.exports 引入。
 *
 * 背景：房间页每秒轮询，轮询响应与主持人控制/编排/停点/预约/交接响应异步并发，
 * 网络往返不保证响应按服务端生成顺序到达；离开房间后旧响应还可能落到刚加入的
 * 另一房间。若无条件用响应覆写 state.room.view 与校时锚点：
 *   1) 先生成的旧轮询在一次成功控制【之后】才返回，会把已 +1 的修订号与新校时
 *      锚点回退（随后携带旧修订号的控制全部 409，画面也跳回旧时码）；
 *   2) 离开 A 房间后 A 的迟到响应写进刚加入的 B 房间（房间码都不同）。
 *
 * 接纳规则（两条同时满足才允许应用到视图与单调时钟锚点）：
 *   - 属于当前房间会话：响应房间码与当前房间一致（sameRoomCode）；同房间码的
 *     离开/重进由调用方维护的会话代次（joinId，每次进入房间递增）另行隔离；
 *   - 不早于已接纳状态：按 (revision, server_wall) 偏序（isAtLeastAsFresh）。
 *
 * 为什么不能只比修订号：自动启播、讨论停点/超载边界自动暂停、惰性落库到末尾
 * 都【不增加修订号】——成功手动控制（revision+1）之后绝不能被同修订号的旧轮询
 * 回退；而两个同修订号响应之间，合法的较新自动状态（server_wall 更大）仍须更新。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RoomView = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 会话隔离第一层：响应必须来自当前房间（房间码一致）。离开后加入另一房间时，
  // 旧房间迟到响应的房间码不同，直接拒绝；同房间码的离开/重进由调用方按 joinId 隔离。
  function sameRoomCode(incoming, roomCode) {
    return !!incoming && typeof incoming === 'object' && incoming.code === roomCode;
  }

  /**
   * 偏序「incoming 不早于 accepted」：
   *  - 修订号更大：一定更新（成功控制/编排/停点/预约/交接领取都令修订号 +1，
   *    服务端修订号只增不减），即使它迟到也携带更新的自动状态；
   *  - 修订号相同：再比服务端墙钟 server_wall（同一服务端组装响应时给出，随请求
   *    处理时刻单调）。自动启播/停点/超载自动暂停/到末尾均不增修订号，同修订号
   *    下只有靠它区分新旧——较新的自动状态仍须接纳，较旧的轮询回包必须拒绝；
   *  - 修订号更小：一定是旧响应，拒绝。
   * 两者完全相等（同修订号、同墙钟）视为同样新鲜：幂等接纳，锚点数值不变。
   * accepted 为 null（刚进入房间、尚无已接纳状态）时一律接纳。
   */
  function isAtLeastAsFresh(incoming, accepted) {
    if (!incoming || typeof incoming !== 'object') return false;
    if (!accepted) return true;
    if (incoming.revision !== accepted.revision) {
      return Number(incoming.revision) > Number(accepted.revision);
    }
    const iw = Number(incoming.server_wall);
    const aw = Number(accepted.server_wall);
    if (!Number.isFinite(iw)) return false;  // 异常响应缺服务端墙钟：不可作为校时锚点
    if (!Number.isFinite(aw)) return true;  // 已接纳锚点缺墙钟（正常不会发生）：信任新响应
    return iw >= aw;
  }

  /**
   * 完整接纳判定：响应是否允许应用到当前房间会话的视图与单调时钟锚点。
   * session = { code, joinId }（发起请求时捕获）；currentJoinId 为调用方当前会话代次。
   * 两条同时成立才接纳：
   *   - 仍属于当前房间会话：房间码与当前房间一致，且会话代次未变（离开房间或重新加入
   *     ——哪怕同一房间码——之后，旧在途响应一律拒绝，不会写进新加入的房间）；
   *   - 不早于已接纳状态：isAtLeastAsFresh 的 (revision, server_wall) 偏序。
   */
  function canApply(incoming, accepted, session, currentJoinId) {
    if (!session || session.joinId !== currentJoinId) return false;
    if (!sameRoomCode(incoming, session.code)) return false;
    return isAtLeastAsFresh(incoming, accepted);
  }

  return { sameRoomCode, isAtLeastAsFresh, canApply };
});
