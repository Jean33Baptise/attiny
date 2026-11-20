# Programmateur ATtiny en ligne - serveur de compilation
FROM python:3.12-slim

ARG ARDUINO_CLI_VERSION=1.1.1
ENV ARDUINO_UPDATER_ENABLE_NOTIFICATION=false \
    ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
    ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/staging \
    ARDUINO_DIRECTORIES_USER=/opt/arduino/user \
    ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS="http://drazzy.com/package_drazzy.com_index.json https://mcudude.github.io/MicroCore/package_MCUdude_MicroCore_index.json" \
    HOST=0.0.0.0 \
    PORT=8080 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR=/usr/local/bin sh -s ${ARDUINO_CLI_VERSION} \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Cores : Arduino AVR (Uno/Nano), ATTinyCore (ATtiny85), MicroCore (ATtiny13)
RUN arduino-cli core update-index \
 && arduino-cli core install arduino:avr ATTinyCore:avr MicroCore:avr \
 && rm -rf /opt/arduino/staging

WORKDIR /app
COPY server.py ./
COPY sketches ./sketches
COPY web ./web

# Utilisateur sans privileges ; le cache de compilation lui appartient
RUN useradd -m appuser && chown -R appuser /opt/arduino /app
USER appuser

# Pre-compile les firmwares et les cores (premiere compilation plus rapide)
RUN python server.py --warm

EXPOSE 8080
CMD ["python", "server.py", "--no-browser"]
