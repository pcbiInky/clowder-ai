declare module 'ws' {
  class WebSocket {
    static readonly OPEN: number;
    readyState: number;

    constructor(url: string, options?: unknown);

    on(event: string, listener: (...args: any[]) => void): this;
    send(data: unknown): void;
    ping(): void;
    close(code?: number, data?: string): void;
    terminate(): void;
    removeAllListeners(): void;
  }

  export default WebSocket;
}
