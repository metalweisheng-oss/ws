FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY fubon/ ./fubon/
RUN pip3 install --break-system-packages -r fubon/requirements.txt

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
