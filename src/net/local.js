/**
 * 本地传输（占位实现）
 *
 * 单机模式下三个对手都是本机 AI，动作直接由 ai.js 产生，不走网络。
 * 这个类的存在是为了让 Transport 接口统一 —— 以后想加"AI 托管掉线玩家"
 * 或者"同一台电脑热座轮打"，换掉这一个文件就行，主流程不用动。
 */

export class LocalTransport {
  constructor() {
    this.id = 'local';
    this.isHost = true;
    this.seatIndex = 0;
    this.state = 'connected';
    this._cbs = {};
  }

  on(evt, cb) { (this._cbs[evt] = this._cbs[evt] || []).push(cb); return this; }
  _emit(evt, ...args) { for (const cb of this._cbs[evt] || []) cb(...args); }

  async connect() { this._emit('status', '本机对战，已就绪'); return this; }
  send() { /* 本机不需要广播 */ }
  sendTo() {}
  broadcastSeats() {}
  close() { this.state = 'closed'; }
}
