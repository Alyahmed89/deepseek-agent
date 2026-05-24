FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache git
RUN git config --global http.version HTTP/1.1
RUN git config --global http.postBuffer 524288000

RUN npm install

COPY . .

ARG CACHEBUST=1
RUN echo "$CACHEBUST"

RUN npm run build

EXPOSE 9090

CMD ["node", "dist/src/main.js"]
