import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { checkpointHash } from '../../assets/scripts/shared/CheckpointCodec';
import { PVP_PROTOCOL_VERSION, PVP_RULESET_VERSION } from '../../assets/scripts/shared/RulesetManifest';
import { ClientEnvelope, ServerEnvelope } from '../../assets/scripts/shared/PvpProtocol';
import { CheckpointV1 } from '../../assets/scripts/shared/PvpTypes';

class TestClient {
    private readonly socket: WebSocket;
    private clientSeq = 0;
    private readonly inbox: ServerEnvelope[] = [];
    private readonly listeners: Array<() => void> = [];

    public constructor(url: string) {
        this.socket = new WebSocket(url);
        this.socket.on('message', raw => {
            this.inbox.push(JSON.parse(raw.toString()) as ServerEnvelope);
            for (const listener of this.listeners.splice(0)) listener();
        });
    }

    public async open(): Promise<void> {
        if (this.socket.readyState === WebSocket.OPEN) return;
        await new Promise<void>((resolve, reject) => {
            this.socket.once('open', resolve);
            this.socket.once('error', reject);
        });
    }

    public send(type: string, payload: unknown): void {
        const envelope: ClientEnvelope = {
            type,
            protocolVersion: PVP_PROTOCOL_VERSION,
            clientSeq: ++this.clientSeq,
            payload,
        };
        this.socket.send(JSON.stringify(envelope));
    }

    public async wait(type: string, timeoutMs = 2_000): Promise<ServerEnvelope> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const index = this.inbox.findIndex(message => message.type === type);
            if (index >= 0) return this.inbox.splice(index, 1)[0];
            const error = this.inbox.find(message => message.type === 'ERROR');
            if (error) throw new Error(`Unexpected ERROR: ${JSON.stringify(error.payload)}`);
            await new Promise<void>((resolve, reject) => {
                const remaining = Math.max(1, timeoutMs - (Date.now() - started));
                const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), remaining);
                this.listeners.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        throw new Error(`Timeout waiting for ${type}`);
    }

    public close(): void {
        this.socket.close();
    }
}

function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
    const host = new TestClient('ws://127.0.0.1:8081?latency=0');
    const guest = new TestClient('ws://127.0.0.1:8081?latency=0');
    await Promise.all([host.open(), guest.open()]);

    host.send('HELLO', { clientInstanceId: randomUUID(), rulesetVersion: PVP_RULESET_VERSION });
    guest.send('HELLO', { clientInstanceId: randomUUID(), rulesetVersion: PVP_RULESET_VERSION });
    await Promise.all([host.wait('HELLO_ACK'), guest.wait('HELLO_ACK')]);

    const roomCode = '123456';
    host.send('JOIN_ROOM', { roomCode });
    const waiting = await host.wait('ROOM_WAITING');
    assert((waiting.payload as { localCamp: string }).localCamp === 'RED', 'host is red');
    guest.send('JOIN_ROOM', { roomCode });
    const [hostPrepare, guestPrepare] = await Promise.all([
        host.wait('MATCH_PREPARE'),
        guest.wait('MATCH_PREPARE'),
    ]);
    const hostPreparePayload = hostPrepare.payload as {
        matchId: string;
        localRole: string;
        initialStateHash: string;
    };
    assert(hostPreparePayload.localRole === 'HOST', 'host role');
    assert((guestPrepare.payload as { localRole: string }).localRole === 'GUEST', 'guest role');
    assert(hostPreparePayload.initialStateHash === 'dba54029', 'initial hash');

    host.send('MATCH_READY', {
        matchId: hostPreparePayload.matchId,
        observedInitialHash: hostPreparePayload.initialStateHash,
    });
    guest.send('MATCH_READY', {
        matchId: hostPreparePayload.matchId,
        observedInitialHash: hostPreparePayload.initialStateHash,
    });
    await Promise.all([host.wait('TURN_BEGIN'), guest.wait('TURN_BEGIN')]);

    const intentId = randomUUID();
    host.send('SHOT_INTENT', {
        roomCode,
        matchId: hostPreparePayload.matchId,
        turnIndex: 0,
        intentId,
        preStateHash: 'dba54029',
        directionXQ: 0,
        directionYQ: 1_000_000,
        pullRatioQ: 5_000,
        curveRatioQ: 0,
    });
    const [hostCommit, guestCommit] = await Promise.all([
        host.wait('SHOT_COMMIT'),
        guest.wait('SHOT_COMMIT'),
    ]);
    const shotId = (hostCommit.payload as { shotId: string }).shotId;
    assert((guestCommit.payload as { shotId: string }).shotId === shotId, 'same shot id');

    const checkpoint: CheckpointV1 = {
        schemaVersion: 1,
        phaseCode: 0,
        turnIndex: 1,
        redScore: 0,
        blueScore: 0,
        winnerCode: 0,
        discs: [
            { idCode: 0, stateCode: 3, xQ: 0, yQ: 0 },
            { idCode: 1, stateCode: 1, xQ: 0, yQ: -740000 },
            { idCode: 2, stateCode: 0, xQ: 0, yQ: 0 },
            { idCode: 3, stateCode: 0, xQ: 0, yQ: 0 },
            { idCode: 4, stateCode: 0, xQ: 0, yQ: 0 },
            { idCode: 5, stateCode: 0, xQ: 0, yQ: 0 },
            { idCode: 6, stateCode: 0, xQ: 0, yQ: 0 },
            { idCode: 7, stateCode: 0, xQ: 0, yQ: 0 },
        ],
    };
    const stateHash = checkpointHash(checkpoint);
    const result = {
        roomCode,
        matchId: hostPreparePayload.matchId,
        completedTurnIndex: 0,
        shotId,
        stateHash,
        checkpoint,
        simulationStatus: 'OK',
        errorCode: null,
    };
    host.send('TURN_SETTLED', result);
    guest.send('TURN_SETTLED', result);
    const [hostAck, guestAck, hostResolution, guestResolution] = await Promise.all([
        host.wait('TURN_SETTLED_ACK'),
        guest.wait('TURN_SETTLED_ACK'),
        host.wait('TURN_CONFIRMED'),
        guest.wait('TURN_CONFIRMED'),
    ]);
    assert((hostAck.payload as { acceptedHash: string }).acceptedHash === stateHash, 'host result ack');
    assert((guestAck.payload as { acceptedHash: string }).acceptedHash === stateHash, 'guest result ack');
    const resolutionId = (hostResolution.payload as { resolutionId: string }).resolutionId;
    assert((guestResolution.payload as { resolutionId: string }).resolutionId === resolutionId, 'same resolution');

    const applied = {
        matchId: hostPreparePayload.matchId,
        completedTurnIndex: 0,
        resolutionId,
        appliedHash: stateHash,
    };
    host.send('TURN_RESOLUTION_APPLIED', applied);
    guest.send('TURN_RESOLUTION_APPLIED', applied);
    const [hostNext, guestNext] = await Promise.all([
        host.wait('TURN_BEGIN'),
        guest.wait('TURN_BEGIN'),
    ]);
    assert((hostNext.payload as { turnIndex: number }).turnIndex === 1, 'host next turn');
    assert((guestNext.payload as { expectedCamp: string }).expectedCamp === 'BLUE', 'blue next');

    console.log(JSON.stringify({
        status: 'PASS',
        roomCode,
        matchId: hostPreparePayload.matchId,
        shotId,
        resolutionId,
        confirmedHash: stateHash,
        nextTurn: 1,
        nextCamp: 'BLUE',
    }, null, 2));
    host.close();
    guest.close();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

