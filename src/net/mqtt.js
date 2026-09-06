/**
 * 联机传输层（默认方案）：MQTT over WebSocket + 免费公共 broker
 *
 * 为什么要这么做：
 *   联机需要一个"大家都能收到消息"的地方。正常思路是买服务器，但公共
 *   MQTT broker 是免费的、匿名的、能扛住我们这点消息量（一局几十条）。
 *   所以——游戏数据走公共 broker 广播，四台设备各自演算（引擎是确定性的），
 *   一分钱不花就能异地开黑。
 *
 * 这里手写了一个够用的 MQTT 3.1.1 客户端，不引第三方库，离线也能跑。
 * 将来你要自己买服务器了：把 server/server.js 跑起来，改用 WsTransport 即可，
 * 游戏层代码一行不动。
 */

/* ==================== 极简 MQTT 3.1.1 客户端 ==================== */

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeLength(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}

function encodeStr(s) {
  const b = enc.encode(s);
  return [(b.length >> 8) & 0xff, b.length & 0xff, ...b];
}

export class TinyMqtt {
  constructor(url, opts = {}) {
    this.url = url;
    this.clientId = opts.clientId || ('wsk_' + Math.random().toString(36).slice(2, 10));
    this.username = opts.username;
    this.password = opts.password;
    this.will = opts.will || null;   // { topic, payload }
    this.keepalive = opts.keepalive || 40;
    this.socketFactory = opts.socketFactory || null; // 测试用：注入假 WebSocket
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.handlers = { message: [], open: [], close: [], error: [] };
    this._pingTimer = null;
    this.connected = false;
  }

  on(evt, cb) { (this.handlers[evt] = this.handlers[evt] || []).push(cb); return this; }
  _emit(evt, ...a) { for (const cb of this.handlers[evt] || []) cb(...a); }

  connect(timeout = 8000) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this.socketFactory
          ? this.socketFactory(this.url, 'mqtt')
          : new WebSocket(this.url, 'mqtt');
      } catch (e) { reject(new Error('无法创建 WebSocket：' + e.message)); return; }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        reject(new Error('连接超时'));
      }, timeout);

      ws.onopen = () => {
        this._sendConnect();
        // 等 CONNACK
        this._onceConnack = (code) => {
          clearTimeout(timer);
          if (code === 0) {
            this.connected = true;
            this._startPing();
            this._emit('open');
            resolve(this);
          } else {
            const msg = { 1: '协议版本不支持', 2: '客户端 ID 被拒', 3: '服务不可用', 4: '账号密码错误', 5: '未授权' }[code] || ('拒绝码 ' + code);
            try { ws.close(); } catch (_) {}
            reject(new Error(msg));
          }
        };
      };

      ws.onmessage = (e) => {
        const chunk = new Uint8Array(e.data);
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf); merged.set(chunk, this.buf.length);
        this.buf = merged;
        this._drain();
      };

      ws.onerror = () => { clearTimeout(timer); reject(new Error('网络连不上')); };
      ws.onclose = () => { clearTimeout(timer); this.connected = false; this._stopPing(); this._emit('close'); };
    });
  }

  _drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const type = b[0] >> 4;
      // 剩余长度
      let multiplier = 1, len = 0, i = 1, digit;
      do {
        if (i >= b.length) return;
        digit = b[i++];
        len += (digit & 127) * multiplier;
        multiplier *= 128;
      } while ((digit & 128) !== 0);

      const total = i + len;
      if (b.length < total) return;
      const body = b.slice(i, total);
      this.buf = b.slice(total);
      this._handle(type, b[0] & 0x0f, body);
    }
  }

  _handle(type, flags, body) {
    if (type === 2) { // CONNACK
      const code = body.length >= 2 ? body[1] : 0;
      if (this._onceConnack) { const f = this._onceConnack; this._onceConnack = null; f(code); }
      return;
    }
    if (type === 3) { // PUBLISH
      let p = 0;
      const tlen = (body[p] << 8) | body[p + 1]; p += 2;
      const topic = dec.decode(body.slice(p, p + tlen)); p += tlen;
      const qos = (flags >> 1) & 3;
      if (qos > 0) p += 2; // packet id
      const payload = dec.decode(body.slice(p));
      this._emit('message', topic, payload);
      return;
    }
    if (type === 13) return; // PINGRESP
    if (type === 9) return;  // SUBACK
  }

  _frame(type, flags, payload) {
    const head = [(type << 4) | (flags & 0x0f), ...encodeLength(payload.length)];
    return new Uint8Array([...head, ...payload]);
  }

  _send(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  _sendConnect() {
    const vh = [
      ...encodeStr('MQTT'),
      0x04,
      (this.username ? 0x80 : 0) | (this.password ? 0x40 : 0) | (this.will ? 0x04 : 0) | 0x02, // will QoS0 + clean session
      (this.keepalive >> 8) & 0xff, this.keepalive & 0xff,
    ];
    let payload = [...encodeStr(this.clientId)];
    if (this.will) payload = payload.concat(encodeStr(this.will.topic), encodeStr(this.will.payload));
    if (this.username) payload = payload.concat(encodeStr(this.username));
    if (this.password) payload = payload.concat(encodeStr(this.password));
    this._send(this._frame(1, 0, new Uint8Array([...vh, ...payload])));
  }

  subscribe(topic) {
    const pid = 1;
    const payload = new Uint8Array([(pid >> 8) & 0xff, pid & 0xff, ...encodeStr(topic), 0]);
    this._send(this._frame(8, 0x02, payload));
  }

  publish(topic, message, opts = {}) {
    const qos = opts.qos || 0;
    let body = [...encodeStr(topic)];
    if (qos > 0) body = body.concat([0, 1]);
    body = body.concat([...enc.encode(message)]);
    this._send(this._frame(3, (qos << 1) | (opts.retain ? 1 : 0), new Uint8Array(body)));
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => this._send(this._frame(12, 0, new Uint8Array(0))), this.keepalive * 500);
  }
  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }

  close() {
    try { this._send(this._frame(14, 0, new Uint8Array(0))); } catch (_) {}
    this._stopPing();
    try { this.ws && this.ws.close(); } catch (_) {}
    this.connected = false;
  }
}

/* ==================== 免费公共 broker 列表（按顺序自动尝试） ==================== */

export const MQTT_BROKERS = [
  { name: 'EMQX 公共（国内推荐）', url: 'wss://broker.emqx.io:8084/mqtt' },
  { name: 'HiveMQ 公共', url: 'wss://broker.hivemq.com:8884/mqtt' },
  { name: 'Mosquitto 测试', url: 'wss://test.mosquitto.org:8081/mqtt' },
];

const TOPIC_PREFIX = 'wushik-henan-v1';

/* ==================== 游戏传输层 ==================== */

export class MqttTransport {
  constructor(brokerIndex = 0, opts = {}) {
    this.id = 'p_' + Math.random().toString(36).slice(2, 10);
    this.name = '';
    this.room = '';
    this.isHost = false;
    this.seatIndex = 0;
    this.peers = [];          // [{id, name, seat}]
    this.mqtt = null;
    this.state = 'idle';
    this._cbs = {};
    this._brokerIndex = brokerIndex;
    this.socketFactory = opts.socketFactory || null; // 测试用：注入假 WebSocket
    // 人齐自动开局：达到这个人数（默认4）房主就自动发牌开牌，不用谁点开始
    this.minPlayers = opts.minPlayers || 4;
    this._emittedFull = false;
  }

  on(evt, cb) { (this._cbs[evt] = this._cbs[evt] || []).push(cb); return this; }
  _emit(evt, ...a) { for (const cb of this._cbs[evt] || []) cb(...a); }

  get topic() { return `${TOPIC_PREFIX}/${this.room}`; }

  async connect(room, name, isHost) {
    this.room = room;
    this.name = name;
    this.isHost = isHost;

    const errors = [];
    const order = [];
    for (let i = 0; i < MQTT_BROKERS.length; i++) order.push((this._brokerIndex + i) % MQTT_BROKERS.length);

    for (const idx of order) {
      const b = MQTT_BROKERS[idx];
      this._brokerIndex = idx;
      this._emit('status', `正在连接${b.name}…`);
      try {
        const mqtt = new TinyMqtt(b.url, {
          clientId: this.id,
          will: { topic: `${TOPIC_PREFIX}/${room}`, payload: JSON.stringify({ t: 'leave', id: this.id }) },
          socketFactory: this.socketFactory || undefined,
        });
        await mqtt.connect(7000);
        mqtt.on('message', (topic, payload) => this._onRaw(payload));
        mqtt.on('close', () => { this.state = 'closed'; this._emit('error', '连接断了'); });
        mqtt.subscribe(`${TOPIC_PREFIX}/${room}`);
        this.mqtt = mqtt;
        this.state = 'connected';
        this._emit('status', `已连上${b.name}，房间 ${room}`);

        if (isHost) {
          this.peers = [{ id: this.id, name, seat: 0 }];
          this.seatIndex = 0;
          this._emittedFull = false;
          this._emit('peers', this.peers);
        } else {
          this.seatIndex = -1;
        }
        // 打招呼
        this.send({ t: 'hello', id: this.id, name });
        // 非房主等房主回 welcome
        if (!isHost) {
          setTimeout(() => {
            if (this.seatIndex < 0) this._emit('status', '还没等到房主响应，确认房间号对不对');
          }, 4000);
        }
        return this;
      } catch (e) {
        errors.push(`${b.name}：${e.message}`);
      }
    }
    throw new Error(errors.join('；'));
  }

  /** 换一个信道重连 */
  async switchBroker() {
    const wasHost = this.isHost, room = this.room, name = this.name;
    this.close();
    this._brokerIndex = (this._brokerIndex + 1) % MQTT_BROKERS.length;
    await this.connect(room, name, wasHost);
  }

  _onRaw(payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (_) { return; }
    if (!msg || !msg.t) return;

    switch (msg.t) {
      case 'hello': {
        if (!this.isHost) break;
        if (this.peers.some((p) => p.id === msg.id)) { this._broadcastPeers(); break; }
        if (this.peers.length >= 4) break;
        const used = new Set(this.peers.map((p) => p.seat));
        let seat = 0; while (used.has(seat)) seat++;
        this.peers.push({ id: msg.id, name: msg.name, seat });
        this._broadcastPeers();
        // 人齐了：自动触发开局（app.js 收到后自动发牌，无需房主点开始）
        if (this.isHost && this.peers.length >= this.minPlayers && !this._emittedFull) {
          this._emittedFull = true;
          this._emit('full', this.peers);
        }
        break;
      }
      case 'peers': {
        if (this.isHost) break;
        this.peers = msg.list || [];
        const me = this.peers.find((p) => p.id === this.id);
        if (me) this.seatIndex = me.seat;
        this._emit('peers', this.peers);
        this._emit('status', `已进房间（你是第 ${this.seatIndex + 1} 家），等房主开局`);
        break;
      }
      case 'leave': {
        if (!this.isHost) break;
        const before = this.peers.length;
        this.peers = this.peers.filter((p) => p.id !== msg.id);
        if (this.peers.length !== before) this._broadcastPeers();
        break;
      }
      case 'start': {
        const my = (msg.assign || {})[this.id];
        if (my === undefined) break;
        this._emit('message', { t: 'start', seed: msg.seed, rules: msg.rules, mySeat: my });
        break;
      }
      default:
        this._emit('message', msg);
    }
  }

  _broadcastPeers() {
    this.send({ t: 'peers', list: this.peers });
    this._emit('peers', this.peers);
  }

  /** 房主开局：给每个人指定座位，广播同一个 seed */
  broadcastSeats(seed, rules) {
    const assign = {};
    for (const p of this.peers) assign[p.id] = p.seat;
    this.seatIndex = assign[this.id] !== undefined ? assign[this.id] : 0;
    this.send({ t: 'start', seed, rules, assign });
  }

  send(msg) {
    if (!this.mqtt) return;
    this.mqtt.publish(this.topic, JSON.stringify(msg));
  }

  sendTo() { /* 广播型信道，点对点直接用 send 即可 */ }

  close() {
    try { this.send({ t: 'leave', id: this.id }); } catch (_) {}
    try { this.mqtt && this.mqtt.close(); } catch (_) {}
    this.state = 'closed';
    this.mqtt = null;
  }
}
