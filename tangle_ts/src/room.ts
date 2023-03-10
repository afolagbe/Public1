import { RustUtilities } from "./rust_utilities";

export interface RoomConfiguration {
    server_url?: string,
    room_name?: string,
    ice_servers?: RTCIceServer[],
    on_state_change?: (room_state: RoomState) => void;
    on_peer_joined?: (peer_id: PeerId) => void;
    on_peer_left?: (peer_id: PeerId, time: number) => void;
    on_message?: (peer_id: PeerId, message: Uint8Array) => void;
}

export type PeerId = number;

export enum RoomState {
    Joining,
    Connected,
    Disconnected
}

type Peer = {
    id: PeerId,
    connection: RTCPeerConnection,
    data_channel: RTCDataChannel,
    ready: boolean,
    latest_message_data: Uint8Array
    latest_message_offset: number,
}

enum MessageType {
    MultiPartStart = 1,
    MultiPartContinuation = 2,
    SinglePart = 3,
    SinglePartGzipped = 4,
}

const MAX_MESSAGE_SIZE = 16_000;

// TODO: This is generated by ChatGPT. Audit it.
function compute_id_from_ip(ipAddress: string): number {
    let uniqueNumber = 0;
    const parts = ipAddress.split(':');
    const ip = parts[0].split('.');
    const port = parseInt(parts[1], 10);

    for (let i = 0; i < 4; i++) {
        uniqueNumber += parseInt(ip[i], 10) * Math.pow(256, 3 - i);
    }
    uniqueNumber += port;

    return uniqueNumber;
}

export class Room {
    private _peers_to_join: Set<PeerId> = new Set();
    private _current_state: RoomState = RoomState.Disconnected;
    private _peers: Map<PeerId, Peer> = new Map();
    private _configuration: RoomConfiguration = {};
    private _outgoing_data_chunk = new Uint8Array(MAX_MESSAGE_SIZE + 5);
    private _rust_utilities: RustUtilities;
    private _server_socket?: WebSocket;

    // Default to 1 because 0 conflicts with the 'system' ID.
    my_id = 1;

    // Used for testing
    private _artificial_delay = 0;

    constructor(rust_utilities: RustUtilities) {
        this._rust_utilities = rust_utilities;
    }

    static async setup(_configuration: RoomConfiguration, rust_utilities: RustUtilities): Promise<Room> {
        const room = new Room(rust_utilities);
        await room._setup_inner(_configuration);
        return room;
    }

    private message_peer_inner(peer: Peer, data: Uint8Array) {
        if (!(peer.data_channel.readyState === "open")) {
            // TODO: This could result in desyncs if this happens.
            return;
        }

        // Gzip encode large messages.
        // For very small messages Gzip encoding actually makes them bigger.
        // This conditional is separate so that if the Gzip data is < MAX_MESSAGE_SIZE 
        // it becomes a small message.
        let message_type = MessageType.SinglePart;
        if (data.byteLength > MAX_MESSAGE_SIZE) {
            message_type = MessageType.SinglePartGzipped;
            data = this._rust_utilities.gzip_encode(data);
        }

        // If the message is too large fragment it. 
        // TODO: If there's not space in the outgoing channel push messages to an outgoing buffer.
        if (data.byteLength > MAX_MESSAGE_SIZE) {
            this._outgoing_data_chunk[0] = MessageType.MultiPartStart;
            new DataView(this._outgoing_data_chunk.buffer).setUint32(1, data.byteLength);

            this._outgoing_data_chunk.set(data.subarray(0, MAX_MESSAGE_SIZE), 5);
            peer.data_channel.send(this._outgoing_data_chunk);

            let data_offset = data.subarray(MAX_MESSAGE_SIZE);

            while (data_offset.byteLength > 0) {
                const length = Math.min(data_offset.byteLength, MAX_MESSAGE_SIZE);
                this._outgoing_data_chunk[0] = MessageType.MultiPartContinuation;
                this._outgoing_data_chunk.set(data_offset.subarray(0, length), 1);
                data_offset = data_offset.subarray(length);

                peer.data_channel.send(this._outgoing_data_chunk.subarray(0, length + 1));

            }
        } else {
            this._outgoing_data_chunk[0] = message_type;
            this._outgoing_data_chunk.set(data, 1);

            peer.data_channel.send(this._outgoing_data_chunk.subarray(0, data.byteLength + 1));
        }

    }

    send_message(data: Uint8Array, peer_id?: PeerId) {
        if (peer_id) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const peer = this._peers.get(peer_id)!;
            this.message_peer_inner(peer, data);
        } else {
            for (const peer of this._peers.values()) {
                if (!peer.ready) {
                    continue;
                }

                this.message_peer_inner(peer, data);
            }
        }
    }

    get_lowest_latency_peer(): PeerId | undefined {
        // TODO: Implement this.
        return this._peers.entries().next().value?.[0];
    }

    private async _setup_inner(room_configuration: RoomConfiguration) {
        this._configuration = room_configuration;
        this._configuration.server_url ??= "tangle-server.fly.dev";
        this._configuration.room_name ??= "";

        // TODO: Do not use metered's Turn servers
        // Investigate routing traffic through Tangle's matchmaking server or other Tangle servers.
        this._configuration.ice_servers ??= [
            {
                urls: "stun:relay.metered.ca:80",
            },
            {
                urls: "stun:stun1.l.google.com:19302"
            },
            {
                urls: "turn:relay.metered.ca:80",
                username: "acb3fd59dc274dbfd4e9ef21",
                credential: "1zeDaNt7C85INfxl",
            },
            {
                urls: "turn:relay.metered.ca:443",
                username: "acb3fd59dc274dbfd4e9ef21",
                credential: "1zeDaNt7C85INfxl",
            },
            {
                urls: "turn:relay.metered.ca:443?transport=tcp",
                username: "acb3fd59dc274dbfd4e9ef21",
                credential: "1zeDaNt7C85INfxl",
            },
        ];

        const connect_to_server = () => {
            const server_socket = new WebSocket("wss://" + this._configuration.server_url);

            let keep_alive_interval: number;

            server_socket.onopen = () => {
                console.log("[room] Connection established with server");
                console.log("[room] Requesting to join room: ", this._configuration.room_name);
                server_socket.send(JSON.stringify({ 'join_room': this._configuration.room_name }));

                // Poke the server every 10 seconds to ensure it doesn't drop our connection.
                // Without this it seems browsers don't send WebSocket native 'pings' as expected.
                // and some server providers (like fly.io) will shutdown inactive TCP sockets.
                // This also gives the server a chance to disconnect peers that become unresponsive.
                clearInterval(keep_alive_interval);
                keep_alive_interval = setInterval(function () {
                    server_socket.send("keep_alive");
                }, 10_000);
            };

            server_socket.onclose = (event) => {
                if (this._current_state != RoomState.Disconnected) {
                    clearInterval(keep_alive_interval);

                    // Disconnecting from the WebSocket is considered a full disconnect from the room.

                    // Call the on_peer_left handler for each peer
                    for (const peer_id of this._peers.keys()) {
                        this._configuration.on_peer_left?.(peer_id, Date.now());
                    }

                    this._current_state = RoomState.Disconnected;
                    this._peers_to_join.clear();
                    this._peers.clear();

                    if (event.wasClean) {
                        console.log(`[room] Server connection closed cleanly, code=${event.code} reason=${event.reason}`);
                    } else {
                        console.log(`[room] Server connection unexpectedly closed. code=${event.code} reason=${event.reason}`);
                        console.log("event: ", event);
                    }

                    this._configuration.on_state_change?.(this._current_state);
                }

                // Attempt to reconnect
                setTimeout(function () {
                    console.log("[room] Attempting to reconnect to server...")
                    connect_to_server();
                }, 250);
            };

            server_socket.onerror = function (error) {
                console.log(`[room] Server socket error:`, error);
                server_socket.close();
            };

            server_socket.onmessage = async (event) => {
                const last_index = event.data.lastIndexOf('}');
                const json = event.data.substring(0, last_index + 1);

                const message = JSON.parse(json);
                // peer_id is appended by the server to the end of incoming messages.
                const peer_ip = event.data.substring(last_index + 1).trim();
                const peer_id = compute_id_from_ip(peer_ip);

                if (message.room_name) {
                    /*
                    const url = new URL(message.room_name);
                    const location = document.location;
                    if (url.href != location.href) {
                        console.error("[room] Tried to join a room that doesn't match current host URL");
                        return;
                    }
                    */

                    // Received when joining a room for the first time.
                    console.log("[room] Entering room: ", message.room_name);

                    this._current_state = RoomState.Joining;

                    const peers_to_join_ids = message.peers.map(compute_id_from_ip);
                    this._peers_to_join = new Set(peers_to_join_ids);

                    this._configuration.on_state_change?.(this._current_state);

                    // If we've already connected to a peer then remove it from _peers_to_join.
                    for (const key of this._peers.keys()) {
                        this._peers_to_join.delete(key);
                    }
                    this.check_if_joined();

                    this.my_id = compute_id_from_ip(message.your_ip);
                    console.log("[room] My id is: %d", this.my_id);
                } else if (message.join_room) {
                    console.log("[room] Peer joining room: ", peer_id);
                    this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
                } else if (message.offer) {
                    const peer_connection = this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
                    await peer_connection.setRemoteDescription(new RTCSessionDescription(message.offer));
                    const answer = await peer_connection.createAnswer();
                    await peer_connection.setLocalDescription(answer);
                    server_socket.send(JSON.stringify({ 'answer': answer, 'destination': peer_ip }));
                } else if (message.answer) {
                    const remoteDesc = new RTCSessionDescription(message.answer);
                    await this._peers.get(peer_id)?.connection.setRemoteDescription(remoteDesc);
                } else if (message.new_ice_candidate) {
                    try {
                        await this._peers.get(peer_id)?.connection.addIceCandidate(message.new_ice_candidate);
                    } catch (e) {
                        console.error("[room] Error adding received ice candidate", e);
                    }
                } else if (message.disconnected_peer_id) {
                    const disconnected_peer_id = compute_id_from_ip(message.disconnected_peer_id);
                    console.log("[room] Peer left: ", disconnected_peer_id);
                    this.remove_peer(disconnected_peer_id, message.time);
                    this._peers_to_join.delete(disconnected_peer_id);
                    this.check_if_joined();
                }
            };
        };
        connect_to_server();
    }

    private check_if_joined() {
        if (this._current_state == RoomState.Joining && this._peers_to_join.size == 0) {
            this._current_state = RoomState.Connected;
            this._configuration.on_state_change?.(this._current_state);
        }
    }

    private make_rtc_peer_connection(peer_ip: string, peer_id: PeerId, server_socket: WebSocket): RTCPeerConnection {
        const peer_connection = new RTCPeerConnection({ 'iceServers': this._configuration.ice_servers });

        // TODO: If this is swapped to a more unreliable UDP-like protocol then ordered and maxRetransmits should be set to false and 0.
        //
        // maxRetransmits: null is meant to be the default but explicitly setting it seems to trigger a Chrome
        // bug where some packets are dropped.
        // TODO: Report this bug.
        const data_channel = peer_connection.createDataChannel("sendChannel", { negotiated: true, id: 2, ordered: true });
        data_channel.binaryType = "arraybuffer";

        peer_connection.onicecandidate = event => {
            console.log("[room] New ice candidate: ", event.candidate);
            if (event.candidate) {
                console.log(JSON.stringify({ 'new_ice_candidate': event.candidate, 'destination': peer_ip }));
                server_socket.send(JSON.stringify({ 'new_ice_candidate': event.candidate, 'destination': peer_ip }));
            }
        };

        peer_connection.onicecandidateerror = (event) => {
            console.log("[room] Ice candidate error: ", event);
        };

        peer_connection.onnegotiationneeded = async () => {
            console.log("[room] Negotiation needed");
            const offer = await peer_connection.createOffer();
            await peer_connection.setLocalDescription(offer);
            server_socket.send(JSON.stringify({ 'offer': offer, 'destination': peer_ip }));
        };

        peer_connection.onsignalingstatechange = () => {
            console.log("[room] Signaling state changed: ", peer_connection.signalingState)
        };

        peer_connection.onconnectionstatechange = () => {
            console.log("[room] Connection state changed: ", peer_connection.connectionState)
        };

        peer_connection.ondatachannel = (event) => {
            peer.data_channel = event.channel;
        };

        data_channel.onopen = () => {
            this._peers_to_join.delete(peer_id);
            peer.ready = true;
            this._configuration.on_peer_joined?.(peer_id);
            this.check_if_joined();
        }

        data_channel.onmessage = (event) => {
            // First check that this peer hasn't been officially disconnected.
            if (this._peers.get(peer_id)) {
                if (event.data.byteLength > 0) {
                    // Defragment the message
                    const message_data = new Uint8Array(event.data);
                    switch (message_data[0]) {
                        case MessageType.SinglePart: {
                            // Call the user provided callback
                            // Message received
                            const data = message_data.subarray(1);

                            // TODO: This introduces a potential one-frame delay on incoming events.
                            setTimeout(() => {
                                this._configuration.on_message?.(peer_id, data);
                            }, this._artificial_delay);
                            break;
                        }
                        case MessageType.SinglePartGzipped: {
                            // Call the user provided callback
                            const data = this._rust_utilities.gzip_decode(message_data.subarray(1));
                            // TODO: This introduces a potential one-frame delay on incoming events.
                            setTimeout(() => {
                                this._configuration.on_message?.(peer_id, data);
                            }, this._artificial_delay);
                            break;
                        }
                        case MessageType.MultiPartStart: {
                            const data = new DataView(message_data.buffer, 1);
                            const length = data.getUint32(0);

                            peer.latest_message_data = new Uint8Array(length);
                            this.multipart_data_received(peer, message_data.subarray(5));
                            break;
                        }
                        case MessageType.MultiPartContinuation: {
                            this.multipart_data_received(peer, message_data.subarray(1));
                        }
                    }
                }
            } else {
                console.error("DISCARDING MESSAGE FROM PEER: ", event.data);
            }
        }

        const peer = { id: peer_id, connection: peer_connection, data_channel, ready: false, latest_message_data: new Uint8Array(0), latest_message_offset: 0 };
        this._peers.set(peer_id, peer);
        return peer_connection;
    }

    private multipart_data_received(peer: Peer, data: Uint8Array) {
        peer.latest_message_data.set(data, peer.latest_message_offset);
        peer.latest_message_offset += data.byteLength;

        if (peer.latest_message_offset == peer.latest_message_data.length) {
            let data = peer.latest_message_data;
            data = this._rust_utilities.gzip_decode(data);

            // TODO: This introduces a potential one-frame delay on incoming events.
            // Message received
            setTimeout(() => {
                this._configuration.on_message?.(peer.id, data);
            }, this._artificial_delay);
            peer.latest_message_offset = 0;
            peer.latest_message_data = new Uint8Array(0);
        }
    }

    private remove_peer(peer_id: PeerId, time: number) {
        const peer = this._peers.get(peer_id);

        if (peer) {
            peer.connection.close();
            this._peers.delete(peer_id);
            this._configuration.on_peer_left?.(peer_id, time);
        }
    }

    disconnect() {
        this._server_socket?.close();
    }
}

