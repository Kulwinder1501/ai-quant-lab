const fs = require('fs');
const path = require('path');

const files = [
  "features/scanner/components/market-scanner-dashboard.tsx",
  "features/dashboard/components/live-price-dashboard.tsx",
  "features/paper-trading/components/paper-trading-dashboard.tsx",
  "features/backtesting/components/backtesting-dashboard.tsx",
  "features/positions/components/positions-dashboard.tsx",
  "features/strategy/components/strategy-dashboard.tsx",
  "features/model-performance/components/model-performance-dashboard.tsx",
  "features/trade-history/components/trade-history-dashboard.tsx",
  "features/news/components/news-dashboard.tsx",
  "features/orders/components/orders-dashboard.tsx",
  "features/predictions/components/ai-predictions-dashboard.tsx"
];

const basePath = "c:\\Users\\Kulwinder Singh\\Desktop\\personal\\AI Quant Lab\\apps\\web\\src";

for (const relPath of files) {
  const fullPath = path.join(basePath, relPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`Skipping missing file: ${fullPath}`);
    continue;
  }
  
  let content = fs.readFileSync(fullPath, 'utf8');
  
  // Replace import
  content = content.replace(/import\s+{\s*ResearchShell\s*}\s+from\s+["'].*?research-shell["'];?\n?/, 
    'import { PageHeader } from "../../../components/layout/page-header";\n');
  
  // Extract props and children
  // The ResearchShell might have newlines between props
  const shellRegex = /<ResearchShell([\s\S]*?)>([\s\S]*?)<\/ResearchShell>/;
  const match = content.match(shellRegex);
  
  if (match) {
    let propsStr = match[1];
    let children = match[2];
    
    // Remove activeView="something"
    propsStr = propsStr.replace(/activeView=(["']).*?\1/g, '').trim();
    // Reformat slightly if it's multiple lines
    // We'll just construct the new PageHeader
    const newHeader = `<PageHeader ${propsStr} />\n      <div className="mt-10">${children}</div>`;
    
    // Also we need to wrap the whole thing in <> if it's not already in a parent.
    // Usually the return ( <ResearchShell... ) needs to be wrapped.
    // The easiest way is to just return <> {newHeader} </>
    const replacement = `<>\n      ${newHeader}\n    </>`;
    
    content = content.replace(shellRegex, replacement);
    
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`Updated: ${relPath}`);
  } else {
    console.log(`No ResearchShell found in: ${relPath}`);
  }
}
