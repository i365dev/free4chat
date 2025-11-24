#!/usr/bin/env python3
import argparse
import asyncio
import json
import requests
import websockets
import uuid
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("free4chat_test_client")

BASE_URL = "http://localhost:4000"
WS_URL = "ws://localhost:4000/socket/websocket"

def get_room_stats(room_id):
    url = f"{BASE_URL}/api/room/{room_id}/stats"
    resp = requests.get(url)
    logger.info(f"Get room stats response ({resp.status_code}): {resp.text}")
    return resp

async def join_room(room_id, nickname="TestBot"):
    async with websockets.connect(WS_URL) as ws:
        join_msg = {
            "topic": f"room:{room_id}",
            "event": "phx_join",
            "payload": {"nickname": nickname},
            "ref": str(uuid.uuid4())
        }
        logger.info(f"Joining room {room_id} as {nickname}")
        await ws.send(json.dumps(join_msg))
        first_resp = await ws.recv()
        logger.info(f"Join response: {first_resp}")

        logger.info("Now listening for events. Type `/text <message>` to send, `/quit` to exit.")

        async def read_user_input():
            loop = asyncio.get_running_loop()
            while True:
                msg = await loop.run_in_executor(None, sys.stdin.readline)
                if not msg:
                    continue
                msg = msg.rstrip()
                if msg == "/quit":
                    logger.info("Quitting join_room client.")
                    break
                elif msg.startswith("/text "):
                    text = msg[6:]
                    push_msg = {
                        "topic": f"room:{room_id}",
                        "event": "textEvent",
                        "payload": {"data": text},
                        "ref": str(uuid.uuid4())
                    }
                    logger.info(f"Sending textEvent: {text}")
                    await ws.send(json.dumps(push_msg))
                else:
                    logger.info("Unknown command. Use `/text <message>` to send or `/quit` to exit.")

        async def receive_ws_events():
            try:
                while True:
                    msg = await ws.recv()
                    logger.info(f"Received: {msg}")
            except (asyncio.CancelledError, websockets.ConnectionClosed):
                pass

        # Run both user input and websocket receives concurrently
        await asyncio.gather(read_user_input(), receive_ws_events())



async def send_text_event(room_id, text, nickname="TextBot"):
    async with websockets.connect(WS_URL) as ws:
        join_msg = {
            "topic": f"room:{room_id}",
            "event": "phx_join",
            "payload": {"nickname": nickname},
            "ref": str(uuid.uuid4())
        }
        logger.info(f"Joining room {room_id} to send text event")
        await ws.send(json.dumps(join_msg))
        join_resp = await ws.recv()
        logger.info(f"Join response: {join_resp}")

        push_msg = {
            "topic": f"room:{room_id}",
            "event": "textEvent",
            "payload": {"data": text},
            "ref": str(uuid.uuid4())
        }
        logger.info(f"Sending textEvent: {text}")
        await ws.send(json.dumps(push_msg))
        # Listen for echo/response briefly
        try:
            for _ in range(5):
                msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                logger.info(f"Received: {msg}")
        except asyncio.TimeoutError:
            logger.info("No more events, done listening.")

def main():
    parser = argparse.ArgumentParser(description="Free4Chat Python test client")
    subparsers = parser.add_subparsers(title="command", dest="command")

    # join_room (persistent)
    p_join = subparsers.add_parser("join_room")
    p_join.add_argument("room_id")
    p_join.add_argument("--nickname", default="TestBot")

    # send_text_event
    p_text = subparsers.add_parser("send_text_event")
    p_text.add_argument("room_id")
    p_text.add_argument("text")
    p_text.add_argument("--nickname", default="TextBot")

    # get_room_stats
    p_stats = subparsers.add_parser("get_room_stats")
    p_stats.add_argument("room_id")

    args = parser.parse_args()

    if args.command == "join_room":
        try:
            asyncio.run(join_room(args.room_id, args.nickname))
        except KeyboardInterrupt:
            logger.info("Gracefully shutting down join_room client.")
    elif args.command == "send_text_event":
        asyncio.run(send_text_event(args.room_id, args.text, args.nickname))
    elif args.command == "get_room_stats":
        get_room_stats(args.room_id)
    else:
        parser.print_help()
        sys.exit(1)

if __name__ == "__main__":
    main()
