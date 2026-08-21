import { ClientEnvelope, ServerEnvelope } from '../shared/PvpProtocol';
import { PVP_PROTOCOL_VERSION } from '../shared/RulesetManifest';

export type SocketState = 'CLOSED' | 'CONNECTING' | 'OPEN' | 'ERROR';

export class WebSocketTransport {
    public onMessage: ((message: ServerEnvelope) => void) | null = null;
    public onStateChange: ((state: SocketState, detail: string) => void) | null = null;
    public onPingSent: ((nonce: string) => void) | null = null;
    public clientSeq = 0;
    public serverSeq = 0;

    private socket: WebSocket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private pingCounter = 0;

    public connect(url: string): void {
        this.close();
        this.clientSeq = 0;
        this.serverSeq = 0;
        this.pingCounter = 0;
        this.changeState('CONNECTING', url);
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.onopen = () => {
            if (this.socket !== socket) return;
            this.changeState('OPEN', 'connected');
            this.heartbeatTimer = setInterval(() => {
                if (this.socket?.readyState === WebSocket.OPEN) {
                    const nonce = `${++this.pingCounter}`;
                    this.onPingSent?.(nonce);
                    this.send('PING', { nonce });
                }
            }, 5_000);
        };
        socket.onmessage = event => {
            if (this.socket === socket) this.receive(String(event.data));
        };
        socket.onerror = () => {
            if (this.socket === socket) this.changeState('ERROR', 'WebSocket error');
        };
        socket.onclose = event => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.stopHeartbeat();
            this.changeState('CLOSED', `${event.code}:${event.reason}`);
        };
    }

    public send(type: string, payload: unknown): number {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('SOCKET_NOT_OPEN');
        }
        const envelope: ClientEnvelope = {
            type,
            protocolVersion: PVP_PROTOCOL_VERSION,
            clientSeq: ++this.clientSeq,
            payload,
        };
        this.socket.send(JSON.stringify(envelope));
        return envelope.clientSeq;
    }

    public close(code = 1000, reason = 'CLIENT_CLOSE'): void {
        this.stopHeartbeat();
        if (this.socket && (
            this.socket.readyState === WebSocket.OPEN
            || this.socket.readyState === WebSocket.CONNECTING
        )) {
            this.socket.close(code, reason);
        }
        this.socket = null;
    }

    public get state(): SocketState {
        if (!this.socket) return 'CLOSED';
        if (this.socket.readyState === WebSocket.CONNECTING) return 'CONNECTING';
        if (this.socket.readyState === WebSocket.OPEN) return 'OPEN';
        return 'CLOSED';
    }

    private receive(text: string): void {
        let envelope: ServerEnvelope;
        try {
            envelope = JSON.parse(text) as ServerEnvelope;
        } catch {
            this.changeState('ERROR', 'MALFORMED_SERVER_JSON');
            this.close(4002, 'MALFORMED_SERVER_JSON');
            return;
        }
        if (envelope.protocolVersion !== PVP_PROTOCOL_VERSION
            || !Number.isSafeInteger(envelope.serverSeq)
            || envelope.serverSeq !== this.serverSeq + 1) {
            this.changeState('ERROR', `SERVER_SEQUENCE:${this.serverSeq}->${envelope.serverSeq}`);
            this.close(4003, 'SERVER_SEQUENCE_GAP');
            return;
        }
        this.serverSeq = envelope.serverSeq;
        this.onMessage?.(envelope);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private changeState(state: SocketState, detail: string): void {
        this.onStateChange?.(state, detail);
    }
}
