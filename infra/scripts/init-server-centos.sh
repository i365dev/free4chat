#!/bin/sh
# Fix DNS and install Docker on CentOS 7 using vault repositories

set -o errexit
set -o nounset

IFS=$(printf '\n\t')

# Backup and create new CentOS repository file
sudo mv /etc/yum.repos.d/CentOS-Base.repo /etc/yum.repos.d/CentOS-Base.repo.backup || true

cat << 'EOF' | sudo tee /etc/yum.repos.d/CentOS-Base.repo
[base]
name=CentOS-7 - Base
baseurl=https://vault.centos.org/centos/7/os/$basearch/
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7

[updates]
name=CentOS-7 - Updates
baseurl=https://vault.centos.org/centos/7/updates/$basearch/
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7

[extras]
name=CentOS-7 - Extras
baseurl=https://vault.centos.org/centos/7/extras/$basearch/
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7
EOF

# Clean and update yum cache
echo "Cleaning and updating yum cache..."
sudo yum clean all
sudo rm -rf /var/cache/yum
sudo yum makecache

# Remove old versions if exist
echo "Removing old Docker versions if they exist..."
sudo yum remove -y docker \
                  docker-client \
                  docker-client-latest \
                  docker-common \
                  docker-latest \
                  docker-latest-logrotate \
                  docker-logrotate \
                  docker-engine || true

# Install required packages
echo "Installing required packages..."
sudo yum install -y yum-utils device-mapper-persistent-data lvm2

# Add Docker repository
echo "Adding Docker repository..."
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# Install Docker
echo "Installing Docker..."
sudo yum install -y docker-ce docker-ce-cli containerd.io

# Configure Docker daemon
echo "Configuring Docker daemon..."
sudo mkdir -p /etc/docker
cat << EOF | sudo tee /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  }
}
EOF

# Start and enable Docker service
echo "Starting Docker service..."
sudo systemctl start docker
sudo systemctl enable docker

# Add current user to docker group
sudo usermod --append --groups docker "$USER"

echo "Docker installed successfully"

# Install Docker Compose
echo "Installing Docker Compose..."
sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.1/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

echo "Docker Compose installed successfully"

# Configure iptables
echo "Configuring iptables..."
sudo yum install -y iptables-services
sudo systemctl start iptables
sudo systemctl enable iptables

sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 4000
sudo iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 4000

# Save iptables rules
sudo service iptables save

echo "IPTables rules configured and saved successfully"

# Display versions and status
echo "Installation completed. Installed versions:"
docker --version || true
docker-compose --version || true

echo "
Please either log out and log back in, or run the following command to use docker:
    newgrp docker

To verify installation, run:
    docker run hello-world"
