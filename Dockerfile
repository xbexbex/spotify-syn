# Use the official Node.js image as the base
FROM node:14-buster

# Install Python 3 and pip
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m pip install --upgrade pip && \
    apt-get install -y build-essential && \
    rm -rf /var/lib/apt/lists/* && \
    pip3 install broadlink

# Set the working directory (optional)
WORKDIR /app

# Copy your application files (if any)
COPY . /app

# Install Node.js dependencies (if you have a package.json)
RUN yarn install

# Expose a port if your application requires it (optional)
# EXPOSE 3000

# Command to run your application (replace with your start command)
CMD ["node", "index.js"]
