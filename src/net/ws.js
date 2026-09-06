/**
 * 联机传输层（进阶方案）：连你自己的服务器
 *
 * 什么时候用这个：
 *   等哪天你买了云服务器（最便宜的几十块一年就够），把 server/server.js
 *   跑起来，然后打开地址 http://你的域名/?server=ws://你的域名:8787
 *   游戏会自动切到这条链路 —— 界面、玩法、AI 全都不用改。
 *
 * 跟 MqttTransport 对外接口完全一致，所以是"热插拔"的。
 */

export class WsTransport {
  constructor(baseUrl) {
    const u = String(baseUrl).replace(/\/$/, '');
    this.baseUrl = u.startsWith('ws') ? u : 'ws://' + u;
    this.id = 'p_' + Math.random().toString(36).slice(2, 10);
    this.name = '';
    this.room = '';
    this.isHost = false;
    this.seatIndex = 0;
    this.peers = [];
    this.ws = null;
    this.state = 'idle';
    this._cbs = {};
  }

  on(evt, cb) { (this._cbs[evt] = this._cbs[evt] || []).push(cb); return this; }
  _emit(evt, ...a) { for (const cb of this._cbs[evt] || []) cb(...a); }

  async connect(room, name, isHost) {
    this.room = room; this.name = name; this.isHost = isHost;
    this._emit('status', '正在连接服务器…');

    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.baseUrl); } catch (e) { reject(new Error('地址不合法：' + e.message)); return; }
      this.ws = ws;

      const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('服务器连不上（超时）')); }, 8000);

      ws.onopen = () => {
        clearTimeout(timer);
        this.state = 'connected';
        this.send({ t: 'join', room, name, id: this.id });
        this._emit('status', '已连服务器，房间 ' + room);
        resolve(this);
      };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
        this._onRaw(msg);
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('服务器连不上')); };
      ws.onclose = () => { this.state = 'closed'; this._emit('error', '连接断了'); };
    });
  }

  _onRaw(msg) {
    switch (msg.t) {
      case 'welcome': {
        this.seatIndex = msg.mySeat;
        this.isHost = msg.seat === 0;
        this.peers = msg.peers || [];
        this._emit('peers', this.peers);
        this._emit('status', `已进房间（第 ${this.seatIndex + 1} 家）`);
        break;
      }
      case 'peers': {
        this.peers = msg.list || [];
        const me = this.peers.find((p) => p.id === this.id);
        if (me) this.seatIndex = me.seat;
        this._emit('peers', this.peers);
        break;
      }
      case 'start': {
        this._emit('message', { t: 'start', seed: msg.seed, rules: msg.rules, mySeat: msg.mySeat });
        break;
      }
      default:
        this._emit('message', msg);
    }
  }

  broadcastSeats(seed, rules) {
    this.send({ t: 'start', seed, rules });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  sendTo() {}

  close() {
    try { this.ws && this.ws.close(); } catch (_) {}
    this.state = 'closed';
  }
}
