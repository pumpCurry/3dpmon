export default class WebSocketMock {
  constructor(url) {
    this.url = url;
    setTimeout(() => this.onopen?.(), 5);
  }
  send(msg) {
    setTimeout(() => this.onmessage?.({ data: msg }), 5);
  }
  close() {
    this.onclose?.();
  }
}
