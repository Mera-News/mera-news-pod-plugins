// Country codes: the news server names countries in ISO 3166 alpha-3, places use alpha-2.
// Each entry is the alpha-2 code followed by the alpha-3 code (Kosovo as XK and XKK).
const PAIRS =
  'ADAND AEARE AFAFG AGATG AIAIA ALALB AMARM AOAGO AQATA ARARG ASASM ATAUT AUAUS AWABW AXALA AZAZE ' +
  'BABIH BBBRB BDBGD BEBEL BFBFA BGBGR BHBHR BIBDI BJBEN BLBLM BMBMU BNBRN BOBOL BQBES BRBRA BSBHS ' +
  'BTBTN BVBVT BWBWA BYBLR BZBLZ CACAN CCCCK CDCOD CFCAF CGCOG CHCHE CICIV CKCOK CLCHL CMCMR CNCHN ' +
  'COCOL CRCRI CUCUB CVCPV CWCUW CXCXR CYCYP CZCZE DEDEU DJDJI DKDNK DMDMA DODOM DZDZA ECECU EEEST ' +
  'EGEGY EHESH ERERI ESESP ETETH FIFIN FJFJI FKFLK FMFSM FOFRO FRFRA GAGAB GBGBR GDGRD GEGEO GFGUF ' +
  'GGGGY GHGHA GIGIB GLGRL GMGMB GNGIN GPGLP GQGNQ GRGRC GSSGS GTGTM GUGUM GWGNB GYGUY HKHKG HMHMD ' +
  'HNHND HRHRV HTHTI HUHUN IDIDN IEIRL ILISR IMIMN ININD IOIOT IQIRQ IRIRN ISISL ITITA JEJEY JMJAM ' +
  'JOJOR JPJPN KEKEN KGKGZ KHKHM KIKIR KMCOM KNKNA KPPRK KRKOR KWKWT KYCYM KZKAZ LALAO LBLBN LCLCA ' +
  'LILIE LKLKA LRLBR LSLSO LTLTU LULUX LVLVA LYLBY MAMAR MCMCO MDMDA MEMNE MFMAF MGMDG MHMHL MKMKD ' +
  'MLMLI MMMMR MNMNG MOMAC MPMNP MQMTQ MRMRT MSMSR MTMLT MUMUS MVMDV MWMWI MXMEX MYMYS MZMOZ NANAM ' +
  'NCNCL NENER NFNFK NGNGA NINIC NLNLD NONOR NPNPL NRNRU NUNIU NZNZL OMOMN PAPAN PEPER PFPYF PGPNG ' +
  'PHPHL PKPAK PLPOL PMSPM PNPCN PRPRI PSPSE PTPRT PWPLW PYPRY QAQAT REREU ROROU RSSRB RURUS RWRWA ' +
  'SASAU SBSLB SCSYC SDSDN SESWE SGSGP SHSHN SISVN SJSJM SKSVK SLSLE SMSMR SNSEN SOSOM SRSUR SSSSD ' +
  'STSTP SVSLV SXSXM SYSYR SZSWZ TCTCA TDTCD TFATF TGTGO THTHA TJTJK TKTKL TLTLS TMTKM TNTUN TOTON ' +
  'TRTUR TTTTO TVTUV TWTWN TZTZA UAUKR UGUGA UMUMI USUSA UYURY UZUZB VAVAT VCVCT VEVEN VGVGB VIVIR ' +
  'VNVNM VUVUT WFWLF WSWSM XKXKK YEYEM YTMYT ZAZAF ZMZMB ZWZWE';

const toAlpha3 = new Map<string, string>();
const toAlpha2 = new Map<string, string>();
for (const pair of PAIRS.split(" ")) {
  toAlpha3.set(pair.slice(0, 2), pair.slice(2));
  toAlpha2.set(pair.slice(2), pair.slice(0, 2));
}

export const alpha3Of = (alpha2: string): string | undefined => toAlpha3.get(alpha2.trim().toUpperCase());

const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });

/** The English name of an alpha-3 code, or the code itself when it names no country. */
export function countryName(alpha3: string): string {
  const alpha2 = toAlpha2.get(alpha3);
  return alpha2 ? names.of(alpha2) ?? alpha3 : alpha3;
}

/** The flag emoji of an alpha-3 code, made of its alpha-2 letters as regional indicators; none for a code that names no country. */
export function flagOf(alpha3: string): string | undefined {
  const alpha2 = toAlpha2.get(alpha3);
  return alpha2 ? String.fromCodePoint(...[...alpha2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : undefined;
}
