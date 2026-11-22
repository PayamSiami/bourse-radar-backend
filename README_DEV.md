# Development Setup for Bourse Radar Backend

## Fixing `npm run dev` Issues

### Problem: Cannot run `npm run dev`

The `npm run dev` command uses: `tsx watch --tsconfig tsconfig.json src/index.ts`

### Common Causes & Solutions

#### 1. Missing/Incomplete node_modules
The earlier npm/pnpm install may have timed out. Run:

```bash
cd bourse-radar-backend
npm install
# Or if you prefer pnpm:
pnpm install
```

#### 2. TypeScript Compilation Errors
Ensure TypeScript compiles without errors:

```bash
npm run build
# or
npx tsc --noEmit
```

If there are errors, fix them in the source files.

#### 3. tsx Not Found
If `tsx` command not found, reinstall:

```bash
npm install tsx --save-dev
```

#### 4. Permission Issues (EPERM)
If getting "EPERM: operation not permitted" errors:
- Close any editors holding file locks
- Run as administrator if needed
- Check antivirus settings

#### 5. Development Server Won't Start
The dev server listens on `http://0.0.0.0:${PORT}`. Make sure:
- Port is not already in use
- Environment variables are set (`.env` file)
- Database (PostgreSQL) is running if needed

### Quick Start

1. **Install dependencies:**
   ```bash
   cd bourse-radar-backend
   npm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Run migrations (if needed):**
   ```bash
   npm run db:migrate
   ```

4. **Start development server:**
   ```bash
   npm run dev
   ```

5. **Access the API:**
   - API: `http://localhost:3000`
   - AdminJS: `http://localhost:3000/admin`
   - Health check: `http://localhost:3000/`

### AdminJS Dashboard
After running `npm run dev`, access the admin dashboard at:
- **URL**: `http://localhost:3000/admin`
- **Features**: User management, ticket management, stock management, task management
- **Login**: Use existing admin credentials from your auth system

### Project Structure
- `src/index.ts` - Main server entry point
- `src/routes/index.ts` - API route registration
- `src/adminjs/` - AdminJS configuration
- `tsconfig.json` - TypeScript configuration
- `package.json` - Dependencies and scripts

### Troubleshooting

If `npm run dev` still fails:
1. Check for TypeScript errors: `npx tsc --noEmit`
2. Verify node_modules exists: `ls node_modules/ | head -5`
3. Try clearing cache: `npm cache clean --force`
4. Delete node_modules and reinstall: `rm -rf node_modules && npm install`
5. Check Node version: `node --version` (requires >=20.0.0)