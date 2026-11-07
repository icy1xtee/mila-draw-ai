"""python -m server — start the web interface (host and port from .env)."""

import logging
import socket

import uvicorn

from . import config


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    print(f"Web interface: http://127.0.0.1:{config.PORT}  |  home network: "
          f"http://{lan_address()}:{config.PORT}", flush=True)
    uvicorn.run("server.app:app", host=config.HOST, port=config.PORT, log_level="warning")
