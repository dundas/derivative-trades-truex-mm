#!/bin/bash
# TrueX Market Maker - Hetzner Deployment Script
#
# Prerequisites:
#   - hcloud CLI installed (brew install hcloud)
#   - SSH key added to Hetzner Cloud
#   - HETZNER_API_KEY set in environment
#
# Usage:
#   ./scripts/deploy-hetzner.sh [create|deploy|destroy]

set -e

# Configuration
SERVER_NAME="truex-mm-prod"
SERVER_TYPE="cx22"  # 2 vCPU, 4GB RAM - adjust as needed
IMAGE="docker-ce"   # Hetzner app with Docker pre-installed
LOCATION="nbg1"     # Nuremberg, Germany
SSH_KEY_NAME="decisive-trades-key"  # Your SSH key name in Hetzner

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check prerequisites
check_prerequisites() {
    if ! command -v hcloud &> /dev/null; then
        log_error "hcloud CLI not found. Install with: brew install hcloud"
        exit 1
    fi

    if [ -z "$HETZNER_API_KEY" ]; then
        log_error "HETZNER_API_KEY not set"
        exit 1
    fi

    # Configure hcloud context
    hcloud context create truex-mm --token "$HETZNER_API_KEY" 2>/dev/null || true
    hcloud context use truex-mm
}

# Create Hetzner server
create_server() {
    log_info "Creating Hetzner server: $SERVER_NAME"

    # Check if server already exists
    if hcloud server describe "$SERVER_NAME" &>/dev/null; then
        log_warn "Server $SERVER_NAME already exists"
        return
    fi

    # Create server with Docker pre-installed
    hcloud server create \
        --name "$SERVER_NAME" \
        --type "$SERVER_TYPE" \
        --image "ubuntu-22.04" \
        --location "$LOCATION" \
        --ssh-key "$SSH_KEY_NAME"

    # Get server IP
    SERVER_IP=$(hcloud server ip "$SERVER_NAME")
    log_info "Server created with IP: $SERVER_IP"

    # Wait for server to be ready
    log_info "Waiting for server to be ready..."
    sleep 30

    # Install Docker
    log_info "Installing Docker on server..."
    ssh -o StrictHostKeyChecking=no root@"$SERVER_IP" << 'ENDSSH'
        apt-get update
        apt-get install -y ca-certificates curl gnupg
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
        apt-get update
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        systemctl enable docker
        systemctl start docker
ENDSSH

    log_info "Server setup complete!"
    echo ""
    echo "Server IP: $SERVER_IP"
    echo "SSH: ssh root@$SERVER_IP"
}

# Deploy application to server
deploy_app() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)

    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found. Run: $0 create"
        exit 1
    fi

    log_info "Deploying to $SERVER_NAME ($SERVER_IP)"

    # Create deployment directory
    ssh root@"$SERVER_IP" "mkdir -p /opt/truex-mm"

    # Copy files
    log_info "Copying files..."
    rsync -avz --exclude='node_modules' --exclude='.git' --exclude='.env' \
        ./ root@"$SERVER_IP":/opt/truex-mm/

    # Copy .env file separately (contains secrets)
    scp .env root@"$SERVER_IP":/opt/truex-mm/.env

    # Build and start containers
    log_info "Building and starting containers..."
    ssh root@"$SERVER_IP" << 'ENDSSH'
        cd /opt/truex-mm
        docker compose down || true
        docker compose build --no-cache
        docker compose up -d fix-proxy market-maker
        docker compose ps
ENDSSH

    log_info "Deployment complete!"
    echo ""
    echo "Server IP: $SERVER_IP"
    echo "FIX Proxy: $SERVER_IP:3004"
    echo ""
    echo "View logs: ssh root@$SERVER_IP 'docker compose -f /opt/truex-mm/docker-compose.yml logs -f'"
}

# Run test on server
run_test() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)

    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found"
        exit 1
    fi

    log_info "Running test on $SERVER_NAME ($SERVER_IP)"

    ssh root@"$SERVER_IP" << 'ENDSSH'
        cd /opt/truex-mm
        docker compose run --rm test-runner
ENDSSH
}

# View logs
view_logs() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)

    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found"
        exit 1
    fi

    ssh root@"$SERVER_IP" "cd /opt/truex-mm && docker compose logs -f --tail=100"
}

# Destroy server
destroy_server() {
    log_warn "This will destroy server $SERVER_NAME and all data!"
    read -p "Are you sure? (yes/no): " confirm

    if [ "$confirm" = "yes" ]; then
        hcloud server delete "$SERVER_NAME"
        log_info "Server destroyed"
    else
        log_info "Cancelled"
    fi
}

# Show status
show_status() {
    log_info "Server status:"
    hcloud server describe "$SERVER_NAME" 2>/dev/null || echo "Server not found"
}

# Open interactive SSH shell
ssh_server() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found"
        exit 1
    fi
    exec ssh root@"$SERVER_IP"
}

# Health check — container status + recent market-maker logs
health_check() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found"
        exit 1
    fi

    log_info "Container health on $SERVER_NAME ($SERVER_IP):"
    ssh root@"$SERVER_IP" << 'ENDSSH'
        echo "=== Containers ==="
        docker ps --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}"
        echo ""
        echo "=== Market Maker (last 30 lines) ==="
        docker logs --tail=30 truex-market-maker 2>/dev/null || echo "(not running)"
        echo ""
        echo "=== WireGuard ==="
        wg show 2>/dev/null | grep -E "interface|latest handshake|transfer" || echo "(no WireGuard)"
ENDSSH
}

# Restart just the market-maker container
restart_mm() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found"
        exit 1
    fi

    log_info "Restarting market-maker on $SERVER_NAME..."
    # Use container name directly — `docker compose restart` can be a no-op if compose project/name mismatch
    ssh root@"$SERVER_IP" "docker restart truex-market-maker"
    log_info "Restarted. Tailing logs (Ctrl+C to exit)..."
    ssh root@"$SERVER_IP" "docker logs -f --tail=50 truex-market-maker"
}

# Graceful stop — cancel orders first, then stop container
stop_mm() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found"
        exit 1
    fi

    log_warn "Stopping market-maker (will cancel all open orders first)..."
    ssh root@"$SERVER_IP" << 'ENDSSH'
        cd /opt/truex-mm
        # Run kill-switch to cancel orders via REST before stopping container
        if docker ps --format '{{.Names}}' | grep -q truex-market-maker; then
            echo "Running kill-switch to cancel open orders..."
            docker exec truex-market-maker bun scripts/kill-switch.js --prod 2>/dev/null || echo "(kill-switch failed — stopping anyway)"
            sleep 3
        fi
        docker compose -f docker-compose.prod.yml stop market-maker
        echo "Market maker stopped."
ENDSSH
}

# Tail live logs
tail_logs() {
    SERVER_IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
    if [ -z "$SERVER_IP" ]; then
        log_error "Server $SERVER_NAME not found"
        exit 1
    fi

    SERVICE="${2:-market-maker}"
    log_info "Tailing logs for $SERVICE (Ctrl+C to exit)..."
    ssh root@"$SERVER_IP" "docker logs -f --tail=100 truex-${SERVICE}"
}

# Main
check_prerequisites

case "${1:-status}" in
    create)
        create_server
        ;;
    deploy)
        deploy_app
        ;;
    test)
        run_test
        ;;
    logs)
        view_logs
        ;;
    tail)
        tail_logs "$@"
        ;;
    destroy)
        destroy_server
        ;;
    status)
        show_status
        ;;
    ssh)
        ssh_server
        ;;
    health)
        health_check
        ;;
    restart)
        restart_mm
        ;;
    stop)
        stop_mm
        ;;
    *)
        echo "Usage: $0 {create|deploy|test|logs|tail|destroy|status|ssh|health|restart|stop}"
        echo ""
        echo "Lifecycle:"
        echo "  create   - Create new Hetzner server"
        echo "  deploy   - Sync code + restart containers"
        echo "  destroy  - Delete server"
        echo ""
        echo "Operations:"
        echo "  restart  - Restart market-maker container"
        echo "  stop     - Graceful stop (cancel orders first)"
        echo "  health   - Container status + recent logs"
        echo "  tail     - Tail live logs [service: market-maker|fix-proxy|redis]"
        echo "  logs     - View logs (non-streaming)"
        echo ""
        echo "Access:"
        echo "  ssh      - Open SSH shell on server"
        echo "  status   - Show Hetzner server status"
        exit 1
        ;;
esac
