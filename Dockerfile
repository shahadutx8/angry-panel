FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
RUN mkdir -p /app/data
ENV PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "server.js"]
