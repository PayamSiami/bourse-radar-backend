# Admin API Documentation

Bourse-Radar Admin API provides a comprehensive set of endpoints to manage users, tickets, stocks, and system analytics.

## Authentication

All admin endpoints require authentication via JWT token with admin role.

### Login
```bash
curl -X POST "http://localhost:8001/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bourse-radar.ir","password":"Admin123!@#"}'
```

Response:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Request Format
Include the token in the Authorization header:
```
Authorization: Bearer {token}
```

## Base URLs

- **API Base**: `http://localhost:8001/api/admin`
- **Dashboard Stats**: `/dashboard/stats`

## Endpoints

### 1. User Management

#### Get Users List
```bash
GET /api/admin/users?page=1&pageSize=20&search=ahmadi&is_admin=true&verified=true
```

**Query Parameters:**
- `page`: Current page number (default: 1)
- `pageSize`: Number of records per page (default: 20)
- `search`: Search by email, username, or display name
- `is_admin`: Filter by admin status (true/false)
- `verified`: Filter by email verification status (true/false)
- `dateFrom`: Filter users created from this date (ISO format)
- `dateTo`: Filter users created until this date (ISO format)

**Response:**
```json
{
  "success": true,
  "data": {
    "users": [/* array of users */],
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8
  }
}
```

#### Get User Details
```bash
GET /api/admin/users/:id
```

#### Update User Role
```bash
PUT /api/admin/users/:id/role
Content-Type: application/json

{
  "is_admin": true
}
```

#### Delete User
```bash
DELETE /api/admin/users/:id
```

### 2. Ticket Management

#### Get Tickets List
```bash
GET /api/admin/tickets?page=1&pageSize=20&status=open&search=مشکل
```

**Query Parameters:**
- `page`: Page number
- `pageSize`: Records per page
- `status`: Filter by status (open, pending, resolved, closed)
- `userId`: Filter by user ID
- `search`: Search in title and description

**Response:**
```json
{
  "success": true,
  "data": {
    "tickets": [/* array of tickets */],
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

#### Get Ticket Details
```bash
GET /api/admin/tickets/:id
```

#### Update Ticket Status
```bash
PUT /api/admin/tickets/:id/status
Content-Type: application/json

{
  "status": "resolved"
}
```

#### Add Response to Ticket
```bash
POST /api/admin/tickets/:id/message
Content-Type: application/json

{
  "message": "پاسخ تیم پشتیبانی به مشکل شما"
}
```

#### Get Ticket Messages
```bash
GET /api/admin/tickets/:id/messages?page=1&pageSize=50
```

### 3. Stock Management

#### Update Stock Information
```bash
PUT /api/admin/stocks/:symbol
Content-Type: application/json

{
  "name": "نام صحیح شرکت",
  "sector": "صنعت",
  "isin": "شماره ISIN",
  "shares_outstanding": 17000000000
}
```

#### Delete Stock
```bash
DELETE /api/admin/stocks/:symbol
```

### 4. Dashboard Statistics

#### Get Admin Statistics
```bash
GET /api/admin/dashboard/stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "users": {
      "total": 1000,
      "newUsers": 50,
      "admins": 5,
      "verifiedUsers": 850
    },
    "tickets": {
      "total": 150,
      "open": 20,
      "pending": 30,
      "resolved": 40
    },
    "stocks": {
      "total": 500,
      "activeWithPrice": 450
    }
  }
}
```

## Error Codes

- `401 Unauthorized`: Invalid or missing token
- `403 Forbidden`: User does not have admin privileges
- `500 Internal Server Error`: Server-side error

## Security Notes

1. Admin users are identified by `is_admin = true` in the users table
2. Token secrets must be configured in `.env` file
3. All admin actions are logged
4. Multiple admin sessions are allowed per user
5. Never grant admin access to non-essential users

## Setup

### 1. Run Migration
```bash
cd bourse-radar-backend
npm run db:migrate
# Or manually:
psql -U postgres -h localhost -d bourse_radar -f migrations/0007_add_admin_roles.sql
```

### 2. Create Admin User
```bash
# Set environment variables
export ADMIN_EMAIL="admin@bourse-radar.ir"
export ADMIN_PASSWORD="Admin123!@#"

# Run the script
node --experimental-strip-types scripts/create-admin.ts
```

### 3. Start Server
```bash
npm run dev
# or
npm start
```

### 4. Test Admin API
```bash
# Login and get token
TOKEN=$(curl -s -X POST "http://localhost:8001/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bourse-radar.ir","password":"Admin123!@#"}' | \
  jq -r .token)

# Get users list
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8001/api/admin/users?page=1"

# Or use the admin client script
node --experimental-strip-types scripts/admin-client.ts
```

## Testing with cURL

### Full Example
```bash
# Login
RESPONSE=$(curl -s -X POST "http://localhost:8001/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bourse-radar.ir","password":"Admin123!@#"}')

TOKEN=$(echo $RESPONSE | jq -r .token)

# Get user list
echo "Getting user list..."
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8001/api/admin/users?page=1&pageSize=10" | jq

# Get tickets
echo "Getting tickets..."
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8001/api/admin/tickets?page=1" | jq

# Get stats
echo "Getting stats..."
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8001/api/admin/dashboard/stats" | jq
```

## Postman Collection

Import the following collection for testing:

```json
{
  "info": {
    "name": "Bourse Radar Admin API",
    "schema": "https://schema.getpostman.com/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Login",
      "request": {
        "method": "POST",
        "url": {
          "raw": "{{base_url}}/api/auth/login",
          "host": ["{{base_url}}"],
          "path": ["api", "auth", "login"]
        },
        "header": [
          {"key": "Content-Type", "value": "application/json"}
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"email\": \"admin@bourse-radar.ir\",\n  \"password\": \"Admin123!@#\"\n}"
        }
      }
    },
    {
      "name": "Get Users",
      "request": {
        "method": "GET",
        "url": {
          "raw": "{{base_url}}/api/admin/users?page=1&pageSize=10",
          "host": ["{{base_url}}"],
          "path": ["api", "admin", "users"],
          "query": [
            {"key": "page", "value": "1"},
            {"key": "pageSize", "value": "10"}
          ]
        },
        "header": [
          {"key": "Authorization", "value": "Bearer {{token}}"}
        ]
      }
    },
    {
      "name": "Get Tickets",
      "request": {
        "method": "GET",
        "url": {
          "raw": "{{base_url}}/api/admin/tickets?page=1&status=open",
          "host": ["{{base_url}}"],
          "path": ["api", "admin", "tickets"],
          "query": [
            {"key": "page", "value": "1"},
            {"key": "status", "value": "open"}
          ]
        },
        "header": [
          {"key": "Authorization", "value": "Bearer {{token}}"}
        ]
      }
    },
    {
      "name": "Get Stats",
      "request": {
        "method": "GET",
        "url": {
          "raw": "{{base_url}}/api/admin/dashboard/stats",
          "host": ["{{base_url}}"],
          "path": ["api", "admin", "dashboard", "stats"]
        },
        "header": [
          {"key": "Authorization", "value": "Bearer {{token}}"}
        ]
      }
    }
  ],
  "variable": [
    {"key": "base_url", "value": "http://localhost:8001"},
    {"key": "token", "value": ""}
  ]
}
```

## Features

### User Management
- Search and filter users by various criteria
- View user details
- Update user admin privileges
- Delete users (except current admin)

### Ticket Management
- View all support tickets
- Filter by status and user
- Respond to tickets
- Change ticket status
- View ticket conversation history

### Stock Management
- Update stock information
- Delete stocks (with proper permissions)
- Verify stock data accuracy

### Dashboard
- Real-time statistics
- User growth metrics
- Ticket status distribution
- Stock activity overview

## Troubleshooting

### Admin Login Fails
1. Check if admin user exists: `node scripts/create-admin.ts`
2. Verify environment variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD`
3. Check JWT_SECRET is set in `.env`

### 403 Forbidden
1. Confirm user has `is_admin = true` in database
2. Check token expiration
3. Verify user ID matches token

### Database Errors
1. Run all migrations: `npm run db:migrate`
2. Check database connection string
3. Verify PostgreSQL is running

## API Client Library (Coming Soon)

A dedicated client library for easier integration will be available soon.
