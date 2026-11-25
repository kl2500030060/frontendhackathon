import crypto from 'crypto';
import type {
  AssetSubtype,
  AuctionCategory,
  AuctionLot,
  AuctionStatus,
  BidRecord,
  DemoSpeed,
  ServerStateSnapshot,
  UserAccount,
  UserRole,
  WalletTransaction,
} from '../src/types/auction.ts';
import { getMinIncrement } from '../src/data/catalog.ts';
import { getDatabaseStatus, getPool, withPgTransaction } from './db.ts';
import { serverTelemetry } from './telemetry.ts';

interface StoredUser extends UserAccount {
  passwordHash: string;
  passwordSalt: string;
}

export interface SecurityAuditRow {
  userId: string;
  username: string;
  name: string;
  role: UserRole;
  hashAlgorithm: string;
  saltPreview: string;
  hashFingerprint: string;
  availableBalance: number;
  escrowBalance: number;
}

const HASH_ALGORITHM_LABEL = 'scrypt (N=16384, r=8, p=1, 64B)';

const SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
    ? process.env.SESSION_SECRET
    : crypto.randomBytes(32).toString('hex');

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, actualSalt, 64).toString('hex');
  return { hash, salt: actualSalt };
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  const derived = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (derived.length !== stored.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

export function signSessionToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { uid?: string };
    return typeof parsed.uid === 'string' ? parsed.uid : null;
  } catch {
    return null;
  }
}

function toPublicUser(u: StoredUser): UserAccount {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    role: u.role,
    availableBalance: u.availableBalance,
    escrowBalance: u.escrowBalance,
    createdAt: u.createdAt,
  };
}

function minutesFromNow(mins: number): number {
  return Date.now() + mins * 60 * 1000;
}

function makeSeedUsers(): StoredUser[] {
  const mk = (
    id: string,
    name: string,
    username: string,
    email: string,
    password: string,
    role: UserRole,
    availableBalance: number
  ): StoredUser => {
    const { hash, salt } = hashPassword(password);
    return {
      id,
      name,
      username,
      email,
      role,
      availableBalance,
      escrowBalance: 0,
      createdAt: Date.now() - 86400000 * 14,
      passwordHash: hash,
      passwordSalt: salt,
    };
  };

  return [
    mk('usr_rahul', 'Rahul Sharma', 'rahul99', 'rahul.sharma@autoauction.in', 'demo123', 'user', 45000000),
    mk('usr_seller', 'Rajesh Motors & Assets', 'seller1', 'rajesh.assets@autoauction.in', 'demo123', 'seller', 8500000),
    mk('usr_admin', 'System Admin', 'admin', 'admin@autoauction.in', 'demo123', 'admin', 90000000),
    mk('usr_meera', 'Meera Nair', 'meeranair', 'meera.nair@capital.in', 'demo123', 'user', 180000000),
    mk('usr_vikram', 'Vikram Desai', 'vikram_d', 'vikram.desai@traders.in', 'demo123', 'user', 160000000),
  ];
}

function makeSeedAuctions(): AuctionLot[] {
  const now = Date.now();
  const baseBid = (amount: number, offsetMs = 600000): BidRecord => ({
    id: `bid_sys_${Math.random().toString(36).slice(2, 8)}`,
    bidderId: 'system',
    bidderName: 'Reserve Opening',
    amount,
    timestamp: now - offsetMs,
    deviceLabel: 'System',
  });

  const extraBid = (
    bidderId: string,
    bidderName: string,
    amount: number,
    offsetMs: number,
    isAutoPilot = false
  ): BidRecord => ({
    id: `bid_${Math.random().toString(36).slice(2, 8)}`,
    bidderId,
    bidderName,
    amount,
    timestamp: now - offsetMs,
    isAutoPilot,
    deviceLabel: isAutoPilot ? 'Auto-Pilot Engine' : 'Institutional Desk',
  });

  return [
    // 1. VEHICLES
    {
      id: 'VEH-4821',
      category: 'vehicles',
      assetType: 'suv',
      title: 'Mahindra Thar 4x4 LX Hard Top',
      description:
        'Single-owner 4x4 diesel automatic recovered under clean finance settlement. Complete authorized service log, original paint, zero structural claims.',
      year: 2023,
      condition: 'A+',
      location: 'Mumbai',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 1350000,
      endTime: minutesFromNow(18),
      status: 'live',
      specs: ['2.2L mHawk Diesel', '24,800 km', 'MH-01 Registered', 'RC & NOC Ready'],
      bids: [
        baseBid(1350000, 720000),
        extraBid('usr_meera', 'Meera Nair', 1400000, 480000),
        extraBid('usr_vikram', 'Vikram Desai', 1450000, 310000),
        extraBid('usr_meera', 'Meera Nair', 1500000, 175000, true),
        extraBid('usr_vikram', 'Vikram Desai', 1550000, 62000),
      ],
      proxyBid: null,
      createdAt: now - 3600000,
    },
    {
      id: 'VEH-3194',
      category: 'vehicles',
      assetType: 'sedan',
      title: 'Honda City ZX e:HEV Hybrid Sedan',
      description:
        'Corporate fleet executive sedan with full ADAS sensing package, leather cabin, and verified insurance clearance.',
      year: 2024,
      condition: 'A+',
      location: 'Bangalore',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 1480000,
      endTime: minutesFromNow(12),
      status: 'live',
      specs: ['1.5L Atkinson Hybrid', '14,200 km', 'KA-03 Registered', 'Comprehensive Ins.'],
      bids: [
        baseBid(1480000, 560000),
        extraBid('usr_vikram', 'Vikram Desai', 1530000, 290000),
        extraBid('usr_meera', 'Meera Nair', 1580000, 110000),
      ],
      proxyBid: null,
      createdAt: now - 3200000,
    },
    {
      id: 'VEH-6042',
      category: 'vehicles',
      assetType: 'pickup',
      title: 'Toyota Hilux High 4x4 Double Cab Pickup',
      description:
        'Heavy-duty utility double cab pickup with factory bed liner, tow hitch, and verified chassis inspection report.',
      year: 2022,
      condition: 'A',
      location: 'Pune',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 2650000,
      endTime: minutesFromNow(26),
      status: 'live',
      specs: ['2.8L Turbo Diesel', '38,400 km', '4WD Low Range', 'Clean Title'],
      bids: [
        baseBid(2650000, 420000),
        extraBid('usr_meera', 'Meera Nair', 2700000, 160000),
      ],
      proxyBid: null,
      createdAt: now - 2800000,
    },
    {
      id: 'VEH-2287',
      category: 'vehicles',
      assetType: 'tractor',
      title: 'Mahindra Arjun Novo 605 DI-i Tractor',
      description:
        'Bank-repossessed 57 HP agricultural tractor with hydraulic PTO, inspected gearbox, and low engine operating hours.',
      year: 2022,
      condition: 'B',
      location: 'Hyderabad',
      sellerId: 'usr_admin',
      sellerName: 'SBI Bank Recovery',
      reservePrice: 520000,
      endTime: minutesFromNow(15),
      status: 'live',
      specs: ['57 HP 4-Cylinder', '640 Engine Hrs', 'Dual Clutch PTO', 'Yard Verified'],
      bids: [
        baseBid(520000, 400000),
        extraBid('usr_vikram', 'Vikram Desai', 530000, 140000),
        extraBid('usr_meera', 'Meera Nair', 540000, 52000),
      ],
      proxyBid: null,
      createdAt: now - 2400000,
    },

    // 2. BULLION VAULTS
    {
      id: 'BUL-7710',
      category: 'bullion',
      assetType: 'gold',
      title: 'SBI Vault 24K Gold Bullion Lot (200g)',
      description:
        'Assayed 999.9 purity hallmarked gold bars liquidated under SARFAESI recovery protocol. Vault pickup at Mumbai Fort branch.',
      year: 2025,
      condition: 'A+',
      location: 'Mumbai',
      sellerId: 'usr_admin',
      sellerName: 'SBI Bullion Desk',
      reservePrice: 1580000,
      endTime: minutesFromNow(10),
      status: 'live',
      specs: ['200 Grams Net', '999.9 Hallmarked', 'Assay Certificate', 'Fort Vault Custody'],
      bids: [
        baseBid(1580000, 620000),
        extraBid('usr_vikram', 'Vikram Desai', 1630000, 410000),
        extraBid('usr_meera', 'Meera Nair', 1680000, 220000),
        extraBid('usr_vikram', 'Vikram Desai', 1730000, 95000, true),
        extraBid('usr_meera', 'Meera Nair', 1780000, 38000),
      ],
      proxyBid: null,
      createdAt: now - 2600000,
    },
    {
      id: 'BUL-4402',
      category: 'bullion',
      assetType: 'silver',
      title: 'MMTC-PAMP 999 Fine Silver Ingot Stack (25 kg)',
      description:
        'Sealed vault pallet containing twenty-five 1kg numbered silver bricks with original refinery assay certificates and insured delivery option.',
      year: 2025,
      condition: 'A+',
      location: 'Ahmedabad',
      sellerId: 'usr_admin',
      sellerName: 'GIFT Bullion Clearing',
      reservePrice: 2250000,
      endTime: minutesFromNow(21),
      status: 'live',
      specs: ['25x 1kg Sealed Bars', '999.0 Fine Silver', 'Serial Matched', 'Vault Insured'],
      bids: [
        baseBid(2250000, 490000),
        extraBid('usr_meera', 'Meera Nair', 2300000, 260000),
        extraBid('usr_vikram', 'Vikram Desai', 2350000, 90000),
      ],
      proxyBid: null,
      createdAt: now - 2500000,
    },
    {
      id: 'BUL-5189',
      category: 'bullion',
      assetType: 'coin_vault',
      title: 'Sovereign 22K Gold Coin Reserve (50 Coins · 400g)',
      description:
        'Tamper-proof bank locker reserve of 50 mint-sealed 8g sovereign coins cleared via court receiver liquidation.',
      year: 2024,
      condition: 'A+',
      location: 'Chennai',
      sellerId: 'usr_admin',
      sellerName: 'Indian Bank Bullion Cell',
      reservePrice: 2950000,
      endTime: minutesFromNow(17),
      status: 'live',
      specs: ['50 Coins (8g Each)', 'BIS 916 Certified', 'Tamper-Proof Cases', 'Branch Handover'],
      bids: [
        baseBid(2950000, 380000),
        extraBid('usr_meera', 'Meera Nair', 3000000, 125000),
      ],
      proxyBid: null,
      createdAt: now - 2350000,
    },

    // 3. REAL ESTATE
    {
      id: 'REA-9105',
      category: 'real_estate',
      assetType: 'villa',
      title: 'Whitefield 3BHK Courtyard Villa (2,450 sq ft)',
      description:
        'Gated community duplex villa with clear RERA title, solar rooftop provision, and covered dual-car parking.',
      year: 2021,
      condition: 'A+',
      location: 'Bangalore',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 11800000,
      endTime: minutesFromNow(32),
      status: 'live',
      specs: ['2,450 sq ft Built-up', 'East Facing', 'Clear Khata & OC', 'Gated Security'],
      bids: [
        baseBid(11800000, 500000),
        extraBid('usr_meera', 'Meera Nair', 12000000, 210000),
        extraBid('usr_vikram', 'Vikram Desai', 12200000, 88000),
      ],
      proxyBid: null,
      createdAt: now - 2200000,
    },
    {
      id: 'REA-4180',
      category: 'real_estate',
      assetType: 'office',
      title: 'Grade-A Commercial Office Suite (1,800 sq ft)',
      description:
        'Plug-and-play tech office floorplate in Cyber Hub corridor with 24-seat layout, conference pod, and active HVAC.',
      year: 2020,
      condition: 'A+',
      location: 'Delhi',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 16500000,
      endTime: minutesFromNow(40),
      status: 'live',
      specs: ['1,800 sq ft Super Area', 'Furnished 24 Seats', '2 Reserved Bays', 'Freehold Title'],
      bids: [baseBid(16500000, 300000)],
      proxyBid: null,
      createdAt: now - 1900000,
    },
    {
      id: 'REA-6312',
      category: 'real_estate',
      assetType: 'land',
      title: 'Highway-Facing Industrial Land Parcel (1.5 Acres)',
      description:
        'NA-converted rectangular plot near Sriperumbudur logistics belt with 60-ft tarmac road frontage and survey demarcation.',
      year: 2024,
      condition: 'A',
      location: 'Chennai',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 7200000,
      endTime: minutesFromNow(28),
      status: 'live',
      specs: ['1.5 Acres NA-Approved', '60ft Road Frontage', 'Boundary Pillars', 'Clear EC'],
      bids: [baseBid(7200000, 280000), extraBid('usr_vikram', 'Vikram Desai', 7300000, 120000)],
      proxyBid: null,
      createdAt: now - 1800000,
    },

    // 4. BANK NPA
    {
      id: 'BNK-5520',
      category: 'bank',
      assetType: 'apartment',
      title: 'Foreclosed 2BHK Flat — Powai Lakeview',
      description:
        'HDFC NPA residential apartment on 11th floor with vacant physical possession and society clearance certificate.',
      year: 2019,
      condition: 'A',
      location: 'Mumbai',
      sellerId: 'usr_admin',
      sellerName: 'HDFC Recovery Desk',
      reservePrice: 6400000,
      endTime: minutesFromNow(22),
      status: 'live',
      specs: ['980 sq ft Carpet', '11th Floor', 'Physical Possession', 'SARFAESI Lot'],
      bids: [
        baseBid(6400000, 420000),
        extraBid('usr_meera', 'Meera Nair', 6500000, 195000),
        extraBid('usr_vikram', 'Vikram Desai', 6600000, 74000),
      ],
      proxyBid: null,
      createdAt: now - 2000000,
    },
    {
      id: 'BNK-8821',
      category: 'bank',
      assetType: 'shop',
      title: 'Defaulted Ground-Floor Retail Shopfront',
      description:
        'High-footfall corner commercial shop space with 18-ft glass frontage, mezzanine storage, and 3-phase power meter.',
      year: 2018,
      condition: 'B',
      location: 'Pune',
      sellerId: 'usr_admin',
      sellerName: 'SBI Bank Recovery',
      reservePrice: 2800000,
      endTime: minutesFromNow(16),
      status: 'live',
      specs: ['460 sq ft Carpet', 'Corner Frontage', '3-Phase Meter', 'Vacant Unit'],
      bids: [baseBid(2800000, 220000), extraBid('usr_vikram', 'Vikram Desai', 2850000, 80000)],
      proxyBid: null,
      createdAt: now - 1600000,
    },

    // 5. INDUSTRIAL PLANTS
    {
      id: 'IND-6204',
      category: 'industrial',
      assetType: 'cnc_machine',
      title: 'DMG MORI DMU-50 5-Axis CNC Machining Center',
      description:
        'Precision German 5-axis simultaneous milling center from aerospace component plant liquidation. Spindle runout certified under 2 microns.',
      year: 2021,
      condition: 'A',
      location: 'Pune',
      sellerId: 'usr_admin',
      sellerName: 'IBBI Plant Liquidator',
      reservePrice: 4800000,
      endTime: minutesFromNow(24),
      status: 'live',
      specs: ['14,000 RPM Spindle', 'Siemens 840D CNC', '30-Tool ATC', 'Factory Floor Ready'],
      bids: [
        baseBid(4800000, 520000),
        extraBid('usr_meera', 'Meera Nair', 4850000, 310000),
        extraBid('usr_vikram', 'Vikram Desai', 4900000, 145000),
        extraBid('usr_meera', 'Meera Nair', 4950000, 58000),
      ],
      proxyBid: null,
      createdAt: now - 2100000,
    },
    {
      id: 'IND-7315',
      category: 'industrial',
      assetType: 'crane',
      title: 'Liebherr 85 EC-B 5 Flat-Top Tower Crane (50m Jib)',
      description:
        'Infra contractor surplus flat-top tower crane with 5-tonne max hoist load, mast sections, and updated third-party load stability certification.',
      year: 2020,
      condition: 'A',
      location: 'Hyderabad',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 6200000,
      endTime: minutesFromNow(30),
      status: 'live',
      specs: ['50m Horizontal Jib', '5T Max Lift', 'Load Certified', 'Dismantled in Yard'],
      bids: [baseBid(6200000, 340000), extraBid('usr_vikram', 'Vikram Desai', 6300000, 120000)],
      proxyBid: null,
      createdAt: now - 1950000,
    },
    {
      id: 'IND-8090',
      category: 'industrial',
      assetType: 'factory_unit',
      title: 'MIDC Chakan Turnkey Stamping Factory Shed (18,000 sq ft)',
      description:
        'Operational industrial plot with 25-ton EOT overhead crane rails, 500kVA HT substation connection, and clear MIDC transfer NOC.',
      year: 2019,
      condition: 'A',
      location: 'Pune',
      sellerId: 'usr_admin',
      sellerName: 'IBBI Plant Liquidator',
      reservePrice: 18500000,
      endTime: minutesFromNow(38),
      status: 'live',
      specs: ['18,000 sq ft Shed', '500kVA HT Power', 'EOT Crane Rails', 'MIDC Leasehold'],
      bids: [baseBid(18500000, 410000), extraBid('usr_meera', 'Meera Nair', 18700000, 165000)],
      proxyBid: null,
      createdAt: now - 1850000,
    },

    // 6. GOV & PSU TENDERS
    {
      id: 'PSU-3011',
      category: 'gov_psu',
      assetType: 'psu_transformer',
      title: 'BHEL 25 MVA 132/33kV Power Substation Transformer',
      description:
        'State utility surplus copper-wound power transformer with OLTC tap changer and recent dissolved-gas oil dielectric test report.',
      year: 2020,
      condition: 'A',
      location: 'Nagpur',
      sellerId: 'usr_admin',
      sellerName: 'MSTC PSU Surplus Desk',
      reservePrice: 3600000,
      endTime: minutesFromNow(19),
      status: 'live',
      specs: ['25 MVA Copper Core', '132/33kV Rated', 'DGA Oil Tested', 'MSTC Lot #412'],
      bids: [
        baseBid(3600000, 460000),
        extraBid('usr_vikram', 'Vikram Desai', 3650000, 210000),
        extraBid('usr_meera', 'Meera Nair', 3700000, 82000),
      ],
      proxyBid: null,
      createdAt: now - 1750000,
    },
    {
      id: 'PSU-4482',
      category: 'gov_psu',
      assetType: 'rail_scrap',
      title: 'Indian Railways Decommissioned Steel Rail & Bogie Lot (120 MT)',
      description:
        'Verified weighbridge bulk tender of 60kg high-carbon steel rail sections and condemned wagon wheelsets stacked at Kharagpur yard.',
      year: 2024,
      condition: 'B',
      location: 'Kolkata',
      sellerId: 'usr_admin',
      sellerName: 'MSTC PSU Surplus Desk',
      reservePrice: 4400000,
      endTime: minutesFromNow(25),
      status: 'live',
      specs: ['120 Metric Tonnes', 'High-Carbon Grade', 'Weighbridge Slip', '30-Day Lifting'],
      bids: [baseBid(4400000, 310000), extraBid('usr_vikram', 'Vikram Desai', 4450000, 115000)],
      proxyBid: null,
      createdAt: now - 1700000,
    },
    {
      id: 'PSU-5920',
      category: 'gov_psu',
      assetType: 'solar_array',
      title: 'NTPC Surplus 250kW Mono-PERC Utility Solar Array Lot',
      description:
        'Unused project surplus batch of 460x 545Wp Tier-1 bifacial solar modules with central string inverters still in factory wooden crates.',
      year: 2024,
      condition: 'A+',
      location: 'Jaipur',
      sellerId: 'usr_admin',
      sellerName: 'MSTC PSU Surplus Desk',
      reservePrice: 3100000,
      endTime: minutesFromNow(23),
      status: 'live',
      specs: ['460 Bifacial Panels', '250kW Peak Output', 'Factory Crated', 'ALMM Approved'],
      bids: [baseBid(3100000, 260000), extraBid('usr_meera', 'Meera Nair', 3150000, 94000)],
      proxyBid: null,
      createdAt: now - 1650000,
    },

    // 7. MARINE & LOGISTICS
    {
      id: 'LOG-2190',
      category: 'logistics',
      assetType: 'container_truck',
      title: 'Volvo FM 420 6x4 Tractor + 40ft Flatbed Container Trailer',
      description:
        'Port-corridor prime mover fleet lot with active National Permit, I-Shift automated transmission, and GPS telematics logs.',
      year: 2022,
      condition: 'A',
      location: 'Mumbai',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 4200000,
      endTime: minutesFromNow(20),
      status: 'live',
      specs: ['420 HP I-Shift', '40ft 3-Axle Trailer', 'National Permit', 'JNPT Fleet Lot'],
      bids: [
        baseBid(4200000, 440000),
        extraBid('usr_meera', 'Meera Nair', 4250000, 190000),
        extraBid('usr_vikram', 'Vikram Desai', 4300000, 68000),
      ],
      proxyBid: null,
      createdAt: now - 1550000,
    },
    {
      id: 'LOG-3804',
      category: 'logistics',
      assetType: 'cargo_vessel',
      title: 'Coastal Feeder Cargo Barge — 1,200 DWT Self-Propelled',
      description:
        'IRS-classed twin-screw coastal feeder vessel moored at Kandla anchorage with valid hull survey and twin Cummins marine diesels.',
      year: 2017,
      condition: 'B',
      location: 'Kandla',
      sellerId: 'usr_admin',
      sellerName: 'Maritime Receiver India',
      reservePrice: 24000000,
      endTime: minutesFromNow(44),
      status: 'live',
      specs: ['1,200 DWT Capacity', 'IRS Class Active', 'Twin Cummins 750HP', 'Kandla Berth'],
      bids: [baseBid(24000000, 380000), extraBid('usr_meera', 'Meera Nair', 24200000, 130000)],
      proxyBid: null,
      createdAt: now - 1500000,
    },
    {
      id: 'LOG-5122',
      category: 'logistics',
      assetType: 'forklift',
      title: 'Kalmar DRG450 Container Yard Reach-Stacker (45T)',
      description:
        'ICD container terminal surplus reach-stacker capable of 5-high container stacking, inspected hydraulics and fresh spreader twistlocks.',
      year: 2021,
      condition: 'A',
      location: 'Chennai',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 7800000,
      endTime: minutesFromNow(27),
      status: 'live',
      specs: ['45 Tonne Spreader', '5-High Stack', '3,900 Meter Hrs', 'Ennore ICD Yard'],
      bids: [baseBid(7800000, 290000)],
      proxyBid: null,
      createdAt: now - 1450000,
    },

    // 8. IT & LIQUIDATION
    {
      id: 'ELC-1904',
      category: 'electronics',
      assetType: 'laptops',
      title: 'Corporate Liquidation: 50x Dell Latitude 7440 Fleet',
      description:
        'Decommissioned enterprise ultrabooks (13th Gen i7, 16GB RAM, 512GB NVMe), Blancco data-wiped with original USB-C adapters.',
      year: 2023,
      condition: 'A',
      location: 'Bangalore',
      sellerId: 'usr_admin',
      sellerName: 'Liquidator Corp India',
      reservePrice: 1250000,
      endTime: minutesFromNow(11),
      status: 'live',
      specs: ['50 Units Verified', 'i7 / 16GB / 512GB', '90%+ Battery Health', 'GST Invoice'],
      bids: [
        baseBid(1250000, 320000),
        extraBid('usr_vikram', 'Vikram Desai', 1300000, 170000),
        extraBid('usr_meera', 'Meera Nair', 1350000, 55000),
      ],
      proxyBid: null,
      createdAt: now - 1400000,
    },
    {
      id: 'ELC-3308',
      category: 'electronics',
      assetType: 'generator',
      title: 'Kirloskar 500kVA Silent DG Industrial Generator',
      description:
        'Acoustic canopy standby diesel generator from plant closure, load-bank tested at 100% capacity with AMF control panel.',
      year: 2021,
      condition: 'A',
      location: 'Chennai',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 920000,
      endTime: minutesFromNow(24),
      status: 'live',
      specs: ['500 kVA 3-Phase', '1,120 Run Hours', 'CPCB-II Acoustic', 'AMF Panel Included'],
      bids: [baseBid(920000, 180000)],
      proxyBid: null,
      createdAt: now - 1200000,
    },

    // 9. LUXURY & FINE ART
    {
      id: 'LUX-9012',
      category: 'luxury',
      assetType: 'chronograph',
      title: 'Omega Speedmaster Moonwatch 18K Sedna Gold Ref. 310',
      description:
        'Box-and-papers Swiss Co-Axial Master Chronometer chronograph verified by authorized horology appraiser. Unpolished case, active warranty.',
      year: 2023,
      condition: 'A+',
      location: 'Mumbai',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 2450000,
      endTime: minutesFromNow(14),
      status: 'live',
      specs: ['Calibre 3861 Manual', '18K Sedna Gold', 'Box & Card Intact', 'Authenticated'],
      bids: [
        baseBid(2450000, 480000),
        extraBid('usr_meera', 'Meera Nair', 2500000, 270000),
        extraBid('usr_vikram', 'Vikram Desai', 2550000, 130000),
        extraBid('usr_meera', 'Meera Nair', 2600000, 44000),
      ],
      proxyBid: null,
      createdAt: now - 1150000,
    },
    {
      id: 'LUX-9440',
      category: 'luxury',
      assetType: 'fine_art',
      title: 'Modernist Oil-on-Canvas Triptych (Provenance Certified)',
      description:
        'Museum-framed 48x72 inch contemporary Indian modernist canvas from corporate art collection restructuring, accompanied by gallery provenance.',
      year: 2016,
      condition: 'A+',
      location: 'Delhi',
      sellerId: 'usr_admin',
      sellerName: 'Estate Asset Trustees',
      reservePrice: 1850000,
      endTime: minutesFromNow(29),
      status: 'live',
      specs: ['48 x 72 in Canvas', 'Gallery Provenance', 'UV Museum Frame', 'Condition Cert.'],
      bids: [baseBid(1850000, 240000), extraBid('usr_vikram', 'Vikram Desai', 1900000, 80000)],
      proxyBid: null,
      createdAt: now - 1050000,
    },
    {
      id: 'LUX-9785',
      category: 'luxury',
      assetType: 'vintage_car',
      title: '1972 Mercedes-Benz 280SL Pagoda Collector Coupe',
      description:
        'Concours-restored right-hand-drive classic GT roadster with matching-numbers inline-6 engine, hardtop + soft-top, and heritage club dossier.',
      year: 1972,
      condition: 'A+',
      location: 'Bangalore',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 9500000,
      endTime: minutesFromNow(36),
      status: 'live',
      specs: ['Matching Numbers', 'RHD Indian Import', 'Concours Restored', 'Heritage Cert.'],
      bids: [
        baseBid(9500000, 450000),
        extraBid('usr_meera', 'Meera Nair', 9600000, 190000),
      ],
      proxyBid: null,
      createdAt: now - 950000,
    },

    // PRE-SETTLED LOTS
    {
      id: 'BUL-1048',
      category: 'bullion',
      assetType: 'gold',
      title: 'MMTC-PAMP 24K Gold Mint Bar (100g · Settled)',
      description:
        'Settled vault bullion lot won by Rahul Sharma with full assay documentation and brokerage contract note generated.',
      year: 2025,
      condition: 'A+',
      location: 'Mumbai',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 780000,
      endTime: now - 1800000,
      status: 'sold',
      specs: ['100 Grams Net', '999.9 Purity', 'Contract Note Ready', 'Vault Released'],
      bids: [
        baseBid(780000, 3600000),
        extraBid('usr_vikram', 'Vikram Desai', 790000, 2900000),
        extraBid('usr_rahul', 'Rahul Sharma', 820000, 2200000),
      ],
      proxyBid: null,
      createdAt: now - 7200000,
    },
    {
      id: 'VEH-1120',
      category: 'vehicles',
      assetType: 'sedan',
      title: 'BMW 330Li M Sport Corporate Lease Sedan (Settled)',
      description:
        'Settled executive sedan lot with clear hypothecation release and brokerage settlement contract note.',
      year: 2023,
      condition: 'A+',
      location: 'Bangalore',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 3850000,
      endTime: now - 3200000,
      status: 'sold',
      specs: ['2.0L TwinPower Turbo', '19,400 km', 'KA-01 Registered', 'Contract Note Ready'],
      bids: [
        baseBid(3850000, 5400000),
        extraBid('usr_meera', 'Meera Nair', 3900000, 4400000),
        extraBid('usr_rahul', 'Rahul Sharma', 3950000, 3600000),
      ],
      proxyBid: null,
      createdAt: now - 8600000,
    },

    // PENDING ADMIN APPROVAL LOTS
    {
      id: 'VEH-9912',
      category: 'vehicles',
      assetType: 'sedan',
      title: 'Skoda Octavia L&K 2.0 TSI Sedan',
      description:
        'Dealer trade-in executive sedan with Canton audio, digital cockpit, and complete authorized dealership records.',
      year: 2022,
      condition: 'A',
      location: 'Delhi',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 1750000,
      endTime: minutesFromNow(45),
      status: 'pending_approval',
      specs: ['2.0L TSI DSG', '28,500 km', 'DL-01 Registered', 'Pending Inspection'],
      bids: [baseBid(1750000, 60000)],
      proxyBid: null,
      createdAt: now - 600000,
    },
    {
      id: 'IND-9940',
      category: 'industrial',
      assetType: 'cnc_machine',
      title: 'Haas VF-4SS Vertical Machining Center (Pending)',
      description:
        'High-speed vertical CNC mill with 12,000 RPM inline direct-drive spindle submitted by verified seller for admin clearance.',
      year: 2022,
      condition: 'A',
      location: 'Coimbatore',
      sellerId: 'usr_seller',
      sellerName: 'Rajesh Motors & Assets',
      reservePrice: 3850000,
      endTime: minutesFromNow(60),
      status: 'pending_approval',
      specs: ['12,000 RPM Direct', '40-Taper Tooling', 'Low Cutting Hrs', 'Pending Approval'],
      bids: [baseBid(3850000, 50000)],
      proxyBid: null,
      createdAt: now - 300000,
    },
  ];
}

export class AuctionStore {
  private users: StoredUser[] = [];
  private auctions: AuctionLot[] = [];
  private transactions: WalletTransaction[] = [];
  private botSpeed: DemoSpeed = 0;

  constructor() {
    this.seedInitialState();
  }

  private seedInitialState(preserveCustomUsers: StoredUser[] = []): void {
    const baseUsers = makeSeedUsers();
    const baseIds = new Set(baseUsers.map((u) => u.id));
    const extras = preserveCustomUsers
      .filter((u) => !baseIds.has(u.id))
      .map((u) => ({
        ...u,
        availableBalance: Math.max(u.availableBalance + u.escrowBalance, 15000000),
        escrowBalance: 0,
      }));
    this.users = [...baseUsers, ...extras];
    this.auctions = makeSeedAuctions();
    this.botSpeed = 0;
    this.transactions = [
      {
        id: 'txn_seed_1',
        userId: 'usr_rahul',
        type: 'top_up',
        amount: 45000000,
        note: 'Initial verified bidding deposit',
        timestamp: Date.now() - 86400000,
      },
      {
        id: 'txn_seed_settle_1',
        userId: 'usr_rahul',
        type: 'settlement_debit',
        amount: 820000,
        lotId: 'BUL-1048',
        lotTitle: 'MMTC-PAMP 24K Gold Mint Bar (100g · Settled)',
        note: 'Final settlement for won lot BUL-1048',
        timestamp: Date.now() - 1800000,
      },
      {
        id: 'txn_seed_settle_2',
        userId: 'usr_rahul',
        type: 'settlement_debit',
        amount: 3950000,
        lotId: 'VEH-1120',
        lotTitle: 'BMW 330Li M Sport Corporate Lease Sedan (Settled)',
        note: 'Final settlement for won lot VEH-1120',
        timestamp: Date.now() - 3200000,
      },
      {
        id: 'txn_seed_2',
        userId: 'usr_seller',
        type: 'top_up',
        amount: 8500000,
        note: 'Seller settlement account opening balance',
        timestamp: Date.now() - 86400000,
      },
      {
        id: 'txn_seed_payout_1',
        userId: 'usr_seller',
        type: 'seller_payout',
        amount: 3871000,
        lotId: 'VEH-1120',
        lotTitle: 'BMW 330Li M Sport Corporate Lease Sedan (Settled)',
        note: 'Net payout (98%) for sold lot VEH-1120',
        timestamp: Date.now() - 3200000,
      },
      {
        id: 'txn_seed_fee_1',
        userId: 'usr_admin',
        type: 'platform_fee',
        amount: 95400,
        lotId: 'VEH-1120',
        lotTitle: 'BMW 330Li M Sport Corporate Lease Sedan (Settled)',
        note: '2% platform brokerage fee on settled lots',
        timestamp: Date.now() - 1800000,
      },
    ];
    for (const lot of this.auctions) {
      if (lot.status !== 'live') continue;
      const top = lot.bids[lot.bids.length - 1];
      if (top && top.bidderId !== 'system') {
        const u = this.users.find((x) => x.id === top.bidderId);
        if (u && u.availableBalance >= top.amount) {
          u.availableBalance -= top.amount;
          u.escrowBalance += top.amount;
        }
      }
    }
  }

  /**
   * Called at server boot after initDatabase().
   * Loads authoritative data from PostgreSQL 16 if present, or seeds Postgres on first launch.
   */
  async hydrateFromPostgres(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    const countRes = await pool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM users');
    const existingUsers = Number(countRes.rows[0]?.cnt ?? 0);

    if (existingUsers === 0) {
      await this.persistFullStateToPostgres(false);
      console.log(`[PostgreSQL] Seeded ${this.users.length} accounts & ${this.auctions.length} lots across 9 sectors.`);
      return;
    }

    // Load authoritative relational state from PostgreSQL
    const [usersRes, auctionsRes, bidsRes, txnsRes] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at ASC'),
      pool.query('SELECT * FROM auctions ORDER BY created_at DESC'),
      pool.query('SELECT * FROM bids ORDER BY created_at ASC'),
      pool.query('SELECT * FROM wallet_transactions ORDER BY created_at DESC LIMIT 300'),
    ]);

    this.users = usersRes.rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      username: String(r.username),
      email: String(r.email),
      role: r.role as UserRole,
      availableBalance: Number(r.available_balance),
      escrowBalance: Number(r.escrow_balance),
      createdAt: Number(r.created_at),
      passwordHash: String(r.password_hash),
      passwordSalt: String(r.password_salt),
    }));

    const bidsByLot = new Map<string, BidRecord[]>();
    for (const b of bidsRes.rows) {
      const lotId = String(b.lot_id);
      const list = bidsByLot.get(lotId) ?? [];
      list.push({
        id: String(b.id),
        bidderId: String(b.bidder_id),
        bidderName: String(b.bidder_name),
        amount: Number(b.amount),
        timestamp: Number(b.created_at),
        isAutoPilot: Boolean(b.is_auto_pilot),
        deviceLabel: String(b.device_label || 'System'),
      });
      bidsByLot.set(lotId, list);
    }

    this.auctions = auctionsRes.rows.map((a) => ({
      id: String(a.id),
      category: a.category as AuctionCategory,
      assetType: a.asset_type as AssetSubtype,
      title: String(a.title),
      description: String(a.description),
      year: Number(a.year),
      condition: a.condition as AuctionLot['condition'],
      location: String(a.location),
      sellerId: String(a.seller_id),
      sellerName: String(a.seller_name),
      reservePrice: Number(a.reserve_price),
      endTime: Number(a.end_time),
      status: a.status as AuctionStatus,
      rejectionReason: a.rejection_reason ? String(a.rejection_reason) : undefined,
      specs: Array.isArray(a.specs) ? a.specs.map(String) : [],
      proxyBid: a.proxy_bid ?? null,
      bids: bidsByLot.get(String(a.id)) ?? [],
      createdAt: Number(a.created_at),
    }));

    this.transactions = txnsRes.rows.map((t) => ({
      id: String(t.id),
      userId: String(t.user_id),
      type: t.type as WalletTransaction['type'],
      amount: Number(t.amount),
      lotId: t.lot_id ? String(t.lot_id) : undefined,
      lotTitle: t.lot_title ? String(t.lot_title) : undefined,
      note: String(t.note),
      timestamp: Number(t.created_at),
    }));

    console.log(
      `[PostgreSQL] Hydrated ${this.users.length} accounts, ${this.auctions.length} lots, and ${bidsRes.rows.length} bids.`
    );
  }

  /**
   * Full parameterized transactional sync (used for initial seed & demo market reset).
   */
  async persistFullStateToPostgres(clearFirst = true): Promise<number> {
    const tx = await withPgTransaction(async (client) => {
      if (clearFirst) {
        await client.query('DELETE FROM bids');
        await client.query('DELETE FROM wallet_transactions');
        await client.query('DELETE FROM auctions');
        await client.query('DELETE FROM users');
      }

      for (const u of this.users) {
        await client.query(
          `INSERT INTO users
            (id, name, username, email, role, available_balance, escrow_balance, password_hash, password_salt, hash_algorithm, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            available_balance = EXCLUDED.available_balance,
            escrow_balance = EXCLUDED.escrow_balance`,
          [
            u.id,
            u.name,
            u.username,
            u.email,
            u.role,
            u.availableBalance,
            u.escrowBalance,
            u.passwordHash,
            u.passwordSalt,
            HASH_ALGORITHM_LABEL,
            u.createdAt,
          ]
        );
      }

      for (const lot of this.auctions) {
        await client.query(
          `INSERT INTO auctions
            (id, category, asset_type, title, description, year, condition, location, seller_id, seller_name, reserve_price, end_time, status, rejection_reason, specs, proxy_bid, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)
           ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            location = EXCLUDED.location,
            condition = EXCLUDED.condition,
            category = EXCLUDED.category,
            asset_type = EXCLUDED.asset_type,
            reserve_price = EXCLUDED.reserve_price,
            end_time = EXCLUDED.end_time,
            status = EXCLUDED.status,
            rejection_reason = EXCLUDED.rejection_reason,
            proxy_bid = EXCLUDED.proxy_bid`,
          [
            lot.id,
            lot.category,
            lot.assetType,
            lot.title,
            lot.description,
            lot.year,
            lot.condition,
            lot.location,
            lot.sellerId,
            lot.sellerName,
            lot.reservePrice,
            lot.endTime,
            lot.status,
            lot.rejectionReason ?? null,
            JSON.stringify(lot.specs),
            lot.proxyBid ? JSON.stringify(lot.proxyBid) : null,
            lot.createdAt,
          ]
        );

        for (const bid of lot.bids) {
          await client.query(
            `INSERT INTO bids (id, lot_id, bidder_id, bidder_name, amount, is_auto_pilot, device_label, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (id) DO NOTHING`,
            [
              bid.id,
              lot.id,
              bid.bidderId,
              bid.bidderName,
              bid.amount,
              Boolean(bid.isAutoPilot),
              bid.deviceLabel ?? 'System',
              bid.timestamp,
            ]
          );
        }
      }

      for (const txn of this.transactions) {
        await client.query(
          `INSERT INTO wallet_transactions (id, user_id, type, amount, lot_id, lot_title, note, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [
            txn.id,
            txn.userId,
            txn.type,
            txn.amount,
            txn.lotId ?? null,
            txn.lotTitle ?? null,
            txn.note,
            txn.timestamp,
          ]
        );
      }
    });
    return tx?.durationMs ?? 0;
  }

  /**
   * Fast atomic PostgreSQL write-through for bids & escrow updates.
   */
  async persistBidMutationToPostgres(
    lot: AuctionLot,
    newBids: BidRecord[],
    touchedUsers: StoredUser[],
    newTxns: WalletTransaction[]
  ): Promise<number> {
    const tx = await withPgTransaction(async (client) => {
      for (const u of touchedUsers) {
        await client.query(
          `UPDATE users SET available_balance = $1, escrow_balance = $2 WHERE id = $3`,
          [u.availableBalance, u.escrowBalance, u.id]
        );
      }

      await client.query(
        `UPDATE auctions SET end_time = $1, status = $2, proxy_bid = $3::jsonb WHERE id = $4`,
        [lot.endTime, lot.status, lot.proxyBid ? JSON.stringify(lot.proxyBid) : null, lot.id]
      );

      for (const bid of newBids) {
        await client.query(
          `INSERT INTO bids (id, lot_id, bidder_id, bidder_name, amount, is_auto_pilot, device_label, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [
            bid.id,
            lot.id,
            bid.bidderId,
            bid.bidderName,
            bid.amount,
            Boolean(bid.isAutoPilot),
            bid.deviceLabel ?? 'Web Client',
            bid.timestamp,
          ]
        );
      }

      for (const txn of newTxns) {
        await client.query(
          `INSERT INTO wallet_transactions (id, user_id, type, amount, lot_id, lot_title, note, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [
            txn.id,
            txn.userId,
            txn.type,
            txn.amount,
            txn.lotId ?? null,
            txn.lotTitle ?? null,
            txn.note,
            txn.timestamp,
          ]
        );
      }
    });
    return tx?.durationMs ?? 0;
  }

  getBotSpeed(): DemoSpeed {
    return this.botSpeed;
  }

  getSnapshot(): ServerStateSnapshot {
    const db = getDatabaseStatus();
    const conn = serverTelemetry.getConnectedSummary();
    return {
      users: this.users.map(toPublicUser),
      auctions: this.auctions,
      transactions: this.transactions,
      botActivityEnabled: this.botSpeed > 0,
      botSpeed: this.botSpeed,
      backendStatus: {
        storageMode: db.storageMode,
        storageLabel: db.storageLabel,
        connectedDevices: {
          total: conn.total,
          mobile: conn.mobile,
          desktop: conn.desktop,
        },
        activeSessionCount: serverTelemetry.getActiveSessions().length,
        hashAlgorithm: HASH_ALGORITHM_LABEL,
      },
      serverTime: Date.now(),
    };
  }

  /**
   * Server-side & loopback SSH monitor ONLY — exposes masked non-reversible salt/hash fingerprints
   * for live cryptography demonstration without ever leaking raw hashes to browser clients.
   */
  getSecurityAuditRows(): SecurityAuditRow[] {
    return this.users.map((u) => ({
      userId: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      hashAlgorithm: HASH_ALGORITHM_LABEL,
      saltPreview: `${u.passwordSalt.slice(0, 8)}...${u.passwordSalt.slice(-4)} (16B)`,
      hashFingerprint: `${u.passwordHash.slice(0, 12)}...${u.passwordHash.slice(-6)} (64B)`,
      availableBalance: u.availableBalance,
      escrowBalance: u.escrowBalance,
    }));
  }

  getUserById(userId: string): UserAccount | null {
    const found = this.users.find((u) => u.id === userId);
    return found ? toPublicUser(found) : null;
  }

  isAdmin(userId: string): boolean {
    const found = this.users.find((u) => u.id === userId);
    return found?.role === 'admin';
  }

  async registerUser(input: {
    name: string;
    username: string;
    email: string;
    password: string;
    role: UserRole;
  }): Promise<{ user: UserAccount; token: string; sqlDurationMs: number } | { error: string }> {
    const name = input.name.trim();
    const username = input.username.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    const password = input.password;
    const role: UserRole = ['user', 'seller', 'admin'].includes(input.role) ? input.role : 'user';

    if (name.length < 2) return { error: 'Full name must be at least 2 characters.' };
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return { error: 'Username must be 3–24 characters using letters, numbers, or underscores.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: 'Enter a valid email address.' };
    }
    if (password.length < 6) {
      return { error: 'Password must be at least 6 characters.' };
    }
    if (this.users.some((u) => u.username.toLowerCase() === username)) {
      return { error: 'That username is already registered.' };
    }
    if (this.users.some((u) => u.email.toLowerCase() === email)) {
      return { error: 'An account with this email already exists.' };
    }

    const { hash, salt } = hashPassword(password);
    const startingBalance = role === 'user' ? 25000000 : role === 'seller' ? 5000000 : 50000000;
    const created: StoredUser = {
      id: `usr_${crypto.randomBytes(4).toString('hex')}`,
      name,
      username,
      email,
      role,
      availableBalance: startingBalance,
      escrowBalance: 0,
      createdAt: Date.now(),
      passwordHash: hash,
      passwordSalt: salt,
    };

    const welcomeTxn: WalletTransaction = {
      id: `txn_${crypto.randomBytes(4).toString('hex')}`,
      userId: created.id,
      type: 'top_up',
      amount: startingBalance,
      note: 'Welcome verified auction credit',
      timestamp: Date.now(),
    };

    this.users.push(created);
    this.transactions.unshift(welcomeTxn);

    const tx = await withPgTransaction(async (client) => {
      await client.query(
        `INSERT INTO users
          (id, name, username, email, role, available_balance, escrow_balance, password_hash, password_salt, hash_algorithm, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          created.id,
          created.name,
          created.username,
          created.email,
          created.role,
          created.availableBalance,
          created.escrowBalance,
          created.passwordHash,
          created.passwordSalt,
          HASH_ALGORITHM_LABEL,
          created.createdAt,
        ]
      );
      await client.query(
        `INSERT INTO wallet_transactions (id, user_id, type, amount, lot_id, lot_title, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          welcomeTxn.id,
          welcomeTxn.userId,
          welcomeTxn.type,
          welcomeTxn.amount,
          null,
          null,
          welcomeTxn.note,
          welcomeTxn.timestamp,
        ]
      );
    });

    return {
      user: toPublicUser(created),
      token: signSessionToken(created.id),
      sqlDurationMs: tx?.durationMs ?? 0,
    };
  }

  loginUser(identifier: string, password: string): { user: UserAccount; token: string } | { error: string } {
    const clean = identifier.trim().toLowerCase();
    if (!clean || !password) {
      return { error: 'Username/email and password are required.' };
    }
    const found = this.users.find(
      (u) => u.username.toLowerCase() === clean || u.email.toLowerCase() === clean
    );
    if (!found || !verifyPassword(password, found.passwordHash, found.passwordSalt)) {
      return { error: 'Invalid username/email or password.' };
    }
    return { user: toPublicUser(found), token: signSessionToken(found.id) };
  }

  async topUpWallet(
    userId: string,
    amount: number
  ): Promise<{ user: UserAccount; txn: WalletTransaction; sqlDurationMs: number } | { error: string }> {
    if (!Number.isFinite(amount) || amount < 50000 || amount > 100000000) {
      return { error: 'Top-up amount must be between ₹50,000 and ₹10,00,00,000.' };
    }
    const user = this.users.find((u) => u.id === userId);
    if (!user) return { error: 'Account not found.' };

    const rounded = Math.round(amount);
    user.availableBalance += rounded;
    const txn: WalletTransaction = {
      id: `txn_${crypto.randomBytes(4).toString('hex')}`,
      userId: user.id,
      type: 'top_up',
      amount: rounded,
      note: 'Instant escrow wallet deposit',
      timestamp: Date.now(),
    };
    this.transactions.unshift(txn);

    const tx = await withPgTransaction(async (client) => {
      await client.query(`UPDATE users SET available_balance = $1 WHERE id = $2`, [
        user.availableBalance,
        user.id,
      ]);
      await client.query(
        `INSERT INTO wallet_transactions (id, user_id, type, amount, lot_id, lot_title, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [txn.id, txn.userId, txn.type, txn.amount, null, null, txn.note, txn.timestamp]
      );
    });

    return { user: toPublicUser(user), txn, sqlDurationMs: tx?.durationMs ?? 0 };
  }

  async placeBid(
    lotId: string,
    userId: string,
    amount: number,
    isAutoPilot = false,
    deviceLabel = 'Web Client'
  ): Promise<
    | {
        lot: AuctionLot;
        outbidUserId?: string;
        autoPilotTriggered?: boolean;
        sqlDurationMs: number;
      }
    | { error: string }
  > {
    const lot = this.auctions.find((a) => a.id === lotId);
    if (!lot) return { error: 'Auction lot not found.' };
    if (lot.status !== 'live' || lot.endTime <= Date.now()) {
      return { error: 'This auction is no longer accepting bids.' };
    }

    const bidder = this.users.find((u) => u.id === userId);
    if (!bidder) return { error: 'User account not found.' };

    const topBid = lot.bids[lot.bids.length - 1];
    const currentAmount = topBid ? topBid.amount : lot.reservePrice;
    const minInc = getMinIncrement(lot.reservePrice);
    const minRequired = currentAmount + minInc;

    const cleanAmount = Math.round(amount);
    if (!Number.isFinite(cleanAmount) || cleanAmount < minRequired) {
      return { error: `Minimum valid bid is ₹${minRequired.toLocaleString('en-IN')}.` };
    }

    const prevLeaderId = topBid && topBid.bidderId !== 'system' ? topBid.bidderId : null;
    const alreadyHeldBySameBidder = prevLeaderId === bidder.id ? topBid.amount : 0;
    const additionalNeeded = cleanAmount - alreadyHeldBySameBidder;

    if (bidder.availableBalance < additionalNeeded) {
      return { error: 'Insufficient available wallet balance. Add funds in Wallet to bid.' };
    }

    const touchedUsers: StoredUser[] = [];
    const newTxns: WalletTransaction[] = [];
    const newBids: BidRecord[] = [];

    // 1. Release previous leader's escrow if different user
    let outbidUserId: string | undefined;
    if (prevLeaderId && prevLeaderId !== bidder.id) {
      const prevUser = this.users.find((u) => u.id === prevLeaderId);
      if (prevUser) {
        const releaseAmt = Math.min(prevUser.escrowBalance, topBid.amount);
        prevUser.escrowBalance -= releaseAmt;
        prevUser.availableBalance += releaseAmt;
        const releaseTxn: WalletTransaction = {
          id: `txn_${crypto.randomBytes(4).toString('hex')}`,
          userId: prevUser.id,
          type: 'escrow_release',
          amount: releaseAmt,
          lotId: lot.id,
          lotTitle: lot.title,
          note: `Escrow released — outbid on ${lot.id}`,
          timestamp: Date.now(),
        };
        this.transactions.unshift(releaseTxn);
        touchedUsers.push(prevUser);
        newTxns.push(releaseTxn);
        outbidUserId = prevUser.id;
      }
    }

    // 2. Lock new bidder's escrow delta
    bidder.availableBalance -= additionalNeeded;
    bidder.escrowBalance += additionalNeeded;
    const holdTxn: WalletTransaction = {
      id: `txn_${crypto.randomBytes(4).toString('hex')}`,
      userId: bidder.id,
      type: 'escrow_hold',
      amount: additionalNeeded,
      lotId: lot.id,
      lotTitle: lot.title,
      note: `${isAutoPilot ? 'Auto-Pilot bid' : 'Live bid'} escrow hold on ${lot.id}`,
      timestamp: Date.now(),
    };
    this.transactions.unshift(holdTxn);
    touchedUsers.push(bidder);
    newTxns.push(holdTxn);

    const placedBid: BidRecord = {
      id: `bid_${crypto.randomBytes(4).toString('hex')}`,
      bidderId: bidder.id,
      bidderName: bidder.name,
      amount: cleanAmount,
      timestamp: Date.now(),
      isAutoPilot,
      deviceLabel,
    };
    lot.bids.push(placedBid);
    newBids.push(placedBid);

    // Soft-close extension
    if (lot.endTime - Date.now() < 30000) {
      lot.endTime = Date.now() + 30000;
    }

    let sqlDurationMs = await this.persistBidMutationToPostgres(
      lot,
      newBids,
      touchedUsers,
      newTxns
    );

    // 3. Evaluate Auto-Pilot Proxy counter-bid if another user holds an active proxy
    let autoPilotTriggered = false;
    if (!isAutoPilot && lot.proxyBid && lot.proxyBid.bidderId !== bidder.id) {
      const nextCounter = cleanAmount + minInc;
      if (nextCounter <= lot.proxyBid.maxLimit) {
        const proxyRes = await this.placeBid(
          lot.id,
          lot.proxyBid.bidderId,
          nextCounter,
          true,
          'Auto-Pilot Engine'
        );
        if (!('error' in proxyRes)) {
          autoPilotTriggered = true;
          outbidUserId = bidder.id;
          sqlDurationMs = Math.round((sqlDurationMs + proxyRes.sqlDurationMs) * 10) / 10;
        }
      }
    }

    return { lot, outbidUserId, autoPilotTriggered, sqlDurationMs };
  }

  async setProxyBid(
    lotId: string,
    userId: string,
    maxLimit: number | null,
    deviceLabel = 'Web Client'
  ): Promise<{ lot: AuctionLot; sqlDurationMs: number } | { error: string }> {
    const lot = this.auctions.find((a) => a.id === lotId);
    if (!lot) return { error: 'Auction lot not found.' };
    if (lot.status !== 'live' || lot.endTime <= Date.now()) {
      return { error: 'Auto-Pilot can only be configured on live lots.' };
    }
    const user = this.users.find((u) => u.id === userId);
    if (!user) return { error: 'User not found.' };

    if (maxLimit === null) {
      if (lot.proxyBid?.bidderId === userId) {
        lot.proxyBid = null;
      }
      const durationMs = await this.persistBidMutationToPostgres(lot, [], [], []);
      return { lot, sqlDurationMs: durationMs };
    }

    const current = lot.bids[lot.bids.length - 1]?.amount ?? lot.reservePrice;
    const minInc = getMinIncrement(lot.reservePrice);
    if (!Number.isFinite(maxLimit) || maxLimit < current + minInc) {
      return { error: `Auto-Pilot limit must be at least ₹${(current + minInc).toLocaleString('en-IN')}.` };
    }

    lot.proxyBid = {
      bidderId: user.id,
      bidderName: user.name,
      maxLimit: Math.round(maxLimit),
    };

    const leader = lot.bids[lot.bids.length - 1];
    let sqlDurationMs = 0;
    if (!leader || leader.bidderId !== user.id) {
      const bidRes = await this.placeBid(
        lot.id,
        user.id,
        current + minInc,
        true,
        `${deviceLabel} (Auto-Pilot)`
      );
      if ('error' in bidRes) {
        lot.proxyBid = null;
        return bidRes;
      }
      sqlDurationMs = bidRes.sqlDurationMs;
    } else {
      sqlDurationMs = await this.persistBidMutationToPostgres(lot, [], [], []);
    }

    return { lot, sqlDurationMs };
  }

  async createAuction(
    actorId: string,
    input: {
      title: string;
      description: string;
      category: AuctionCategory;
      assetType: AssetSubtype;
      year: number;
      condition: AuctionLot['condition'];
      location: string;
      reservePrice: number;
      durationMinutes: number;
      specs?: string[];
    }
  ): Promise<{ lot: AuctionLot; sqlDurationMs: number } | { error: string }> {
    const actor = this.users.find((u) => u.id === actorId);
    if (!actor || (actor.role !== 'seller' && actor.role !== 'admin')) {
      return { error: 'Only verified sellers or admins can submit listings.' };
    }

    const title = input.title.trim();
    const description = input.description.trim();
    const location = input.location.trim();

    if (title.length < 4) return { error: 'Asset title must be at least 4 characters.' };
    if (!location) return { error: 'City or location is required.' };
    if (!Number.isFinite(input.reservePrice) || input.reservePrice < 10000) {
      return { error: 'Reserve price must be at least ₹10,000.' };
    }
    if (!Number.isFinite(input.durationMinutes) || input.durationMinutes < 2 || input.durationMinutes > 1440) {
      return { error: 'Duration must be between 2 and 1440 minutes.' };
    }

    const prefixMap: Record<AuctionCategory, string> = {
      vehicles: 'VEH',
      real_estate: 'REA',
      bank: 'BNK',
      bullion: 'BUL',
      industrial: 'IND',
      gov_psu: 'PSU',
      logistics: 'LOG',
      electronics: 'ELC',
      luxury: 'LUX',
    };
    const prefix = prefixMap[input.category] ?? 'LOT';
    const id = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
    const status: AuctionStatus = actor.role === 'admin' ? 'live' : 'pending_approval';
    const reserve = Math.round(input.reservePrice);

    const openBid: BidRecord = {
      id: `bid_sys_${crypto.randomBytes(3).toString('hex')}`,
      bidderId: 'system',
      bidderName: 'Reserve Opening',
      amount: reserve,
      timestamp: Date.now(),
      deviceLabel: 'System',
    };

    const lot: AuctionLot = {
      id,
      category: input.category,
      assetType: input.assetType,
      title,
      description: description || `${title} listed by ${actor.name} with verified title documentation.`,
      year: Math.min(2026, Math.max(1950, Math.round(input.year || 2024))),
      condition: input.condition || 'A',
      location,
      sellerId: actor.id,
      sellerName: actor.name,
      reservePrice: reserve,
      endTime: minutesFromNow(input.durationMinutes),
      status,
      specs:
        input.specs && input.specs.length > 0
          ? input.specs
          : [`Condition ${input.condition || 'A'}`, location, 'Verified Documentation'],
      bids: [openBid],
      proxyBid: null,
      createdAt: Date.now(),
    };

    this.auctions.unshift(lot);

    const tx = await withPgTransaction(async (client) => {
      await client.query(
        `INSERT INTO auctions
          (id, category, asset_type, title, description, year, condition, location, seller_id, seller_name, reserve_price, end_time, status, rejection_reason, specs, proxy_bid, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)`,
        [
          lot.id,
          lot.category,
          lot.assetType,
          lot.title,
          lot.description,
          lot.year,
          lot.condition,
          lot.location,
          lot.sellerId,
          lot.sellerName,
          lot.reservePrice,
          lot.endTime,
          lot.status,
          null,
          JSON.stringify(lot.specs),
          null,
          lot.createdAt,
        ]
      );
      await client.query(
        `INSERT INTO bids (id, lot_id, bidder_id, bidder_name, amount, is_auto_pilot, device_label, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [openBid.id, lot.id, openBid.bidderId, openBid.bidderName, openBid.amount, false, 'System', openBid.timestamp]
      );
    });

    return { lot, sqlDurationMs: tx?.durationMs ?? 0 };
  }

  async updateAuction(
    actorId: string,
    lotId: string,
    patch: Partial<
      Pick<AuctionLot, 'title' | 'description' | 'location' | 'condition' | 'reservePrice' | 'assetType' | 'category'>
    >
  ): Promise<{ lot: AuctionLot } | { error: string }> {
    const actor = this.users.find((u) => u.id === actorId);
    const lot = this.auctions.find((a) => a.id === lotId);
    if (!actor || !lot) return { error: 'Lot not found.' };

    const isOwner = lot.sellerId === actor.id;
    if (actor.role !== 'admin' && !isOwner) {
      return { error: 'You do not have permission to edit this lot.' };
    }
    if (lot.bids.length > 1 && patch.reservePrice !== undefined) {
      return { error: 'Reserve price cannot be edited after bids have been placed.' };
    }

    if (patch.title && patch.title.trim().length >= 4) lot.title = patch.title.trim();
    if (patch.description !== undefined) lot.description = patch.description.trim();
    if (patch.location && patch.location.trim()) lot.location = patch.location.trim();
    if (patch.condition) lot.condition = patch.condition;
    if (patch.category) lot.category = patch.category;
    if (patch.assetType) lot.assetType = patch.assetType;
    if (patch.reservePrice && patch.reservePrice >= 10000 && lot.bids.length <= 1) {
      lot.reservePrice = Math.round(patch.reservePrice);
      if (lot.bids[0]) lot.bids[0].amount = lot.reservePrice;
    }

    await withPgTransaction(async (client) => {
      await client.query(
        `UPDATE auctions
         SET title=$1, description=$2, location=$3, condition=$4, category=$5, asset_type=$6, reserve_price=$7
         WHERE id=$8`,
        [
          lot.title,
          lot.description,
          lot.location,
          lot.condition,
          lot.category,
          lot.assetType,
          lot.reservePrice,
          lot.id,
        ]
      );
      if (lot.bids.length === 1 && lot.bids[0]) {
        await client.query(`UPDATE bids SET amount = $1 WHERE id = $2`, [
          lot.bids[0].amount,
          lot.bids[0].id,
        ]);
      }
    });

    return { lot };
  }

  async deleteAuction(actorId: string, lotId: string): Promise<{ deletedId: string } | { error: string }> {
    const actor = this.users.find((u) => u.id === actorId);
    const idx = this.auctions.findIndex((a) => a.id === lotId);
    if (!actor || idx === -1) return { error: 'Lot not found.' };

    const lot = this.auctions[idx];
    const canDelete =
      actor.role === 'admin' || (lot.sellerId === actor.id && lot.status !== 'live' && lot.status !== 'sold');

    if (!canDelete) {
      return { error: 'Active or settled lots can only be removed by an administrator.' };
    }

    let refundedUser: StoredUser | null = null;
    const top = lot.bids[lot.bids.length - 1];
    if (lot.status === 'live' && top && top.bidderId !== 'system') {
      const leader = this.users.find((u) => u.id === top.bidderId);
      if (leader) {
        const rel = Math.min(leader.escrowBalance, top.amount);
        leader.escrowBalance -= rel;
        leader.availableBalance += rel;
        refundedUser = leader;
      }
    }

    this.auctions.splice(idx, 1);

    await withPgTransaction(async (client) => {
      if (refundedUser) {
        await client.query(
          `UPDATE users SET available_balance = $1, escrow_balance = $2 WHERE id = $3`,
          [refundedUser.availableBalance, refundedUser.escrowBalance, refundedUser.id]
        );
      }
      await client.query(`DELETE FROM auctions WHERE id = $1`, [lotId]);
    });

    return { deletedId: lotId };
  }

  async moderateAuction(
    adminId: string,
    lotId: string,
    decision: 'approve' | 'reject',
    reason?: string
  ): Promise<{ lot: AuctionLot } | { error: string }> {
    const admin = this.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== 'admin') return { error: 'Admin access required.' };

    const lot = this.auctions.find((a) => a.id === lotId);
    if (!lot) return { error: 'Lot not found.' };

    if (decision === 'approve') {
      lot.status = 'live';
      lot.rejectionReason = undefined;
      if (lot.endTime <= Date.now() + 120000) {
        lot.endTime = minutesFromNow(25);
      }
    } else {
      lot.status = 'rejected';
      lot.rejectionReason = reason?.trim() || 'Incomplete asset documentation.';
    }

    const pool = getPool();
    if (pool) {
      await pool.query(
        `UPDATE auctions SET status = $1, rejection_reason = $2, end_time = $3 WHERE id = $4`,
        [lot.status, lot.rejectionReason ?? null, lot.endTime, lot.id]
      );
    }

    return { lot };
  }

  async updateUserRole(
    adminId: string,
    targetUserId: string,
    role: UserRole
  ): Promise<{ user: UserAccount } | { error: string }> {
    const admin = this.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== 'admin') return { error: 'Admin access required.' };

    const target = this.users.find((u) => u.id === targetUserId);
    if (!target) return { error: 'User not found.' };
    if (target.id === admin.id) return { error: 'You cannot change your own active admin role.' };
    if (!['user', 'seller', 'admin'].includes(role)) return { error: 'Invalid role.' };

    target.role = role;
    const pool = getPool();
    if (pool) {
      await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, target.id]);
    }
    return { user: toPublicUser(target) };
  }

  async deleteUser(adminId: string, targetUserId: string): Promise<{ deletedId: string } | { error: string }> {
    const admin = this.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== 'admin') return { error: 'Admin access required.' };
    if (adminId === targetUserId) return { error: 'Cannot delete the currently logged-in admin account.' };

    const idx = this.users.findIndex((u) => u.id === targetUserId);
    if (idx === -1) return { error: 'User not found.' };

    this.users.splice(idx, 1);
    const pool = getPool();
    if (pool) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [targetUserId]);
    }
    return { deletedId: targetUserId };
  }

  toggleBotActivity(adminId: string): { enabled: boolean; speed: DemoSpeed } | { error: string } {
    const admin = this.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== 'admin') return { error: 'Admin access required.' };
    this.botSpeed = this.botSpeed > 0 ? 0 : 1;
    return { enabled: this.botSpeed > 0, speed: this.botSpeed };
  }

  setBotSpeed(adminId: string, speed: DemoSpeed): { speed: DemoSpeed; enabled: boolean } | { error: string } {
    const admin = this.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== 'admin') return { error: 'Admin access required.' };
    if (![0, 1, 2, 5, 10].includes(speed)) {
      return { error: 'Speed must be 0 (OFF), 1, 2, 5, or 10.' };
    }
    this.botSpeed = speed;
    return { speed: this.botSpeed, enabled: this.botSpeed > 0 };
  }

  async resetDemoMarket(adminId: string): Promise<{ ok: true; totalLots: number; sqlDurationMs: number } | { error: string }> {
    const admin = this.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== 'admin') return { error: 'Admin access required.' };
    this.seedInitialState(this.users);
    const sqlDurationMs = await this.persistFullStateToPostgres(true);
    return { ok: true, totalLots: this.auctions.length, sqlDurationMs };
  }

  async replenishDemoMarket(adminId: string): Promise<{ added: number } | { error: string }> {
    const admin = this.users.find((u) => u.id === adminId);
    if (!admin || admin.role !== 'admin') return { error: 'Admin access required.' };

    const pool = makeSeedAuctions().filter((l) => l.status === 'live');
    const picks = [pool[0], pool[4], pool[12], pool[23]].filter(Boolean);
    const fresh = picks.map((lot) => ({
      ...lot,
      id: `${lot.id.slice(0, 3)}-${Math.floor(1000 + Math.random() * 9000)}`,
      endTime: minutesFromNow(15 + Math.floor(Math.random() * 20)),
      status: 'live' as const,
      createdAt: Date.now(),
    }));
    this.auctions = [...fresh, ...this.auctions];
    await this.persistFullStateToPostgres(false);
    return { added: fresh.length };
  }

  async settleExpiredAuctions(): Promise<AuctionLot[]> {
    const now = Date.now();
    const settled: AuctionLot[] = [];
    const touchedUsers: StoredUser[] = [];
    const newTxns: WalletTransaction[] = [];

    for (const lot of this.auctions) {
      if (lot.status !== 'live' || lot.endTime > now) continue;

      const topBid = lot.bids[lot.bids.length - 1];
      if (topBid && topBid.bidderId !== 'system') {
        lot.status = 'sold';
        const winner = this.users.find((u) => u.id === topBid.bidderId);
        if (winner) {
          const deduct = Math.min(winner.escrowBalance, topBid.amount);
          winner.escrowBalance -= deduct;
          touchedUsers.push(winner);
          const debitTxn: WalletTransaction = {
            id: `txn_${crypto.randomBytes(4).toString('hex')}`,
            userId: winner.id,
            type: 'settlement_debit',
            amount: topBid.amount,
            lotId: lot.id,
            lotTitle: lot.title,
            note: `Final settlement for won lot ${lot.id}`,
            timestamp: now,
          };
          this.transactions.unshift(debitTxn);
          newTxns.push(debitTxn);
        }

        const commission = Math.round(topBid.amount * 0.02);
        const sellerNet = topBid.amount - commission;
        const seller = this.users.find((u) => u.id === lot.sellerId);
        if (seller) {
          seller.availableBalance += sellerNet;
          touchedUsers.push(seller);
          const payoutTxn: WalletTransaction = {
            id: `txn_${crypto.randomBytes(4).toString('hex')}`,
            userId: seller.id,
            type: 'seller_payout',
            amount: sellerNet,
            lotId: lot.id,
            lotTitle: lot.title,
            note: `Net payout (98%) for sold lot ${lot.id}`,
            timestamp: now,
          };
          this.transactions.unshift(payoutTxn);
          newTxns.push(payoutTxn);
        }

        const feeTxn: WalletTransaction = {
          id: `txn_${crypto.randomBytes(4).toString('hex')}`,
          userId: 'usr_admin',
          type: 'platform_fee',
          amount: commission,
          lotId: lot.id,
          lotTitle: lot.title,
          note: `2% platform settlement commission on ${lot.id}`,
          timestamp: now,
        };
        this.transactions.unshift(feeTxn);
        newTxns.push(feeTxn);
      } else {
        lot.status = 'unsold';
      }

      await this.persistBidMutationToPostgres(lot, [], touchedUsers, newTxns);
      settled.push(lot);
    }

    return settled;
  }

  private ensureBotLiquidity(bot: StoredUser, required: number): void {
    if (bot.availableBalance < required) {
      bot.availableBalance += required + 50000000;
    }
  }

  async triggerBiddingWarStep(
    lotId: string,
    sourceLabel = 'Demo War Engine'
  ): Promise<{ lot: AuctionLot; outbidUserId?: string; autoPilotTriggered?: boolean; sqlDurationMs: number } | null> {
    const lot = this.auctions.find((a) => a.id === lotId);
    if (!lot || lot.status !== 'live' || lot.endTime <= Date.now()) return null;

    const botPool = this.users.filter((u) => u.id === 'usr_meera' || u.id === 'usr_vikram');
    if (botPool.length === 0) return null;

    const topBid = lot.bids[lot.bids.length - 1];
    const eligibleBots = botPool.filter((b) => b.id !== topBid?.bidderId);
    const bot =
      eligibleBots.length > 0
        ? eligibleBots[Math.floor(Math.random() * eligibleBots.length)]
        : botPool[0];

    const nextAmt = (topBid?.amount ?? lot.reservePrice) + getMinIncrement(lot.reservePrice);
    this.ensureBotLiquidity(bot, nextAmt);

    const res = await this.placeBid(lot.id, bot.id, nextAmt, false, sourceLabel);
    if ('error' in res) return null;
    return {
      lot: res.lot,
      outbidUserId: res.outbidUserId,
      autoPilotTriggered: res.autoPilotTriggered,
      sqlDurationMs: res.sqlDurationMs,
    };
  }

  async runOptionalBotTick(): Promise<{ lot: AuctionLot; outbidUserId?: string; autoPilotTriggered?: boolean; sqlDurationMs: number } | null> {
    if (this.botSpeed === 0) return null;
    const liveLots = this.auctions.filter((a) => a.status === 'live' && a.endTime > Date.now());
    if (liveLots.length === 0) return null;

    const targetLot = liveLots[Math.floor(Math.random() * liveLots.length)];
    return this.triggerBiddingWarStep(targetLot.id, `Demo Bot (${this.botSpeed}x)`);
  }
}

export const auctionStore = new AuctionStore();
