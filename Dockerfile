FROM node:18-alpine

# Install ping utility and libcap for raw network permissions
RUN apk add --no-cache iputils libcap

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]