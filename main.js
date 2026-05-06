// === CONFIG === //
const HELSINKI_CENTER = [24.9415, 60.1706];
const AREA_COLORS = ['#ff007b','#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444'];
const COLOR_SCALE = [
  [0,66,157],[71,113,178],[115,162,198],[165,213,216],
  [255,255,224],[255,188,175],[244,119,127],[207,55,89],[147,0,58]
];

// === STATE === //
let appState = {
  year: 2023, showHousingProd: false, showCityPlans: false,
  is3DExtruded: false, scatterMetric: 'price_vs_income',
  selectedAreas: new Set(), hoveredPC: null
};
let rawCsv = [], geoPostalCodes = null, geoHousingProd = null, geoCityPlans = null;
let postalCentroids = new Map(), currentDataMap = new Map();
let postalNameMap = new Map(); // posnro -> nimi
let tenureData = new Map(); // posnro -> {owner, rental, other, total}

// === HELPERS === //
function calcDistance(lon1,lat1,lon2,lat2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function getPriceColor(price) {
  let p = Math.max(0,Math.min(1,(price-2000)/7000));
  return COLOR_SCALE[Math.floor(p*(COLOR_SCALE.length-1))];
}
function fmtK(v) {
  if (Math.abs(v)>=1000) return (v/1000).toFixed(v>=10000?0:1)+'k';
  return String(Math.round(v));
}
function getAreaColor(pc) {
  const arr = Array.from(appState.selectedAreas);
  const idx = arr.indexOf(pc);
  return idx >= 0 ? AREA_COLORS[idx % AREA_COLORS.length] : '#94a3b8';
}

// === DECK.GL INIT === //
const deckgl = new deck.DeckGL({
  container: 'map-container',
  mapStyle: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  initialViewState: { longitude:24.93, latitude:60.25, zoom:10.3, pitch:0, bearing:0, minZoom:4 },
  controller: {
    maxBounds: {west:19.0, south:59.0, east:32.0, north:70.5} // restrict to Finland
  },
  getCursor: ({isHovering}) => isHovering ? 'pointer' : 'grab',
  getTooltip: () => null, // We use custom info card
  onHover: ({object}) => {
    if (!object || !object.properties) { setHoveredPC(null); return; }
    const pc = object.properties.posnro || null;
    setHoveredPC(pc);
    if (pc) showInfoCard(pc, object.properties);
    else if (object.properties.kaavatun) showOverlayCard(object.properties, 'plan');
    else if (object.properties.Valmistumisvuosi) showOverlayCard(object.properties, 'housing');
    else hideInfoCard();
  },
  onClick: ({object}) => {
    if (!object || !object.properties || !object.properties.posnro) return;
    toggleAreaSelection(object.properties.posnro);
  }
});

// === SHARED AREA TOGGLE === //
function toggleAreaSelection(pc) {
  const tagsContainer = document.getElementById('active-tags');
  if (appState.selectedAreas.has(pc)) {
    // Deselect
    appState.selectedAreas.delete(pc);
    const existingTag = tagsContainer.querySelector(`[data-pc="${pc}"]`);
    if (existingTag) existingTag.remove();
  } else {
    // Select
    appState.selectedAreas.add(pc);
    const name = postalNameMap.get(pc) || 'Unknown';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.setAttribute('data-pc', pc);
    tag.innerHTML = `${pc} ${name} <span class="tag-close">×</span>`;
    tag.querySelector('.tag-close').addEventListener('click', () => {
      appState.selectedAreas.delete(pc);
      tag.remove();
      updateDataAndRender();
    });
    tagsContainer.appendChild(tag);
  }
  updateDataAndRender();
}

function setHoveredPC(pc) {
  if (appState.hoveredPC === pc) return;
  appState.hoveredPC = pc;
  highlightScatterDot(pc);
  renderLayers(); // update map highlight
}

function showInfoCard(pc, props) {
  const card = document.getElementById('info-card');
  const content = document.getElementById('info-card-content');
  const d = currentDataMap.get(pc);
  let html = `<div class="ic-title">${pc} — ${props.nimi||'Unknown'}</div>`;
  if (d) {
    html += `<div class="ic-row"><span class="ic-label">Price</span><span class="ic-value">€${Math.round(d.price).toLocaleString()}/m²</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Sales</span><span class="ic-value">${d.sales}</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Population</span><span class="ic-value">${d.pop.toLocaleString()}</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Avg Income</span><span class="ic-value">€${Math.round(d.income).toLocaleString()}</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Dist. to Center</span><span class="ic-value">${d.distance.toFixed(1)} km</span></div>`;
  } else {
    html += `<div class="ic-row"><span class="ic-label" style="color:#94a3b8">No transaction data for ${appState.year}</span></div>`;
  }
  content.innerHTML = html;
  card.classList.remove('hidden');
}
function showOverlayCard(props, type) {
  const card = document.getElementById('info-card');
  const content = document.getElementById('info-card-content');
  let html = '';
  if (type === 'plan') {
    html = `<div class="ic-title">📋 ${props.kaavanimi}</div>`;
    html += `<div class="ic-row"><span class="ic-label">Municipality</span><span class="ic-value">${props.kuntanimi}</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Residential Area</span><span class="ic-value">${(props.netyhteens||0).toLocaleString()} m²</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Year Entered Force</span><span class="ic-value">${props.vtulvuosi}</span></div>`;
  } else {
    html = `<div class="ic-title">🏗️ Housing Production</div>`;
    html += `<div class="ic-row"><span class="ic-label">Municipality</span><span class="ic-value">${props.Sijaintikunta}</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Apartments</span><span class="ic-value">${props.Asuntoluku}</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Year</span><span class="ic-value">${props.Valmistumisvuosi}</span></div>`;
    html += `<div class="ic-row"><span class="ic-label">Type</span><span class="ic-value">${props.Talotyyppi}</span></div>`;
  }
  content.innerHTML = html;
  card.classList.remove('hidden');
}
function hideInfoCard() { document.getElementById('info-card').classList.add('hidden'); }

// === DATA LOADING === //
Promise.all([
  d3.csv('./data/merged_housing_data.csv'),
  d3.json('./data/postal_codes_boundary.geojson'),
  d3.json('./data/housing_production_2020_2023.geojson'),
  d3.json('./data/new_city_plans_2020_2023.geojson')
]).then(([csv, postalGeo, housingGeo, plansGeo]) => {
  rawCsv = csv;
  geoPostalCodes = postalGeo;
  geoHousingProd = housingGeo;
  geoCityPlans = plansGeo;
  geoPostalCodes.features.forEach(f => {
    let lons=0,lats=0,n=0;
    const coords = f.geometry.type==='MultiPolygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
    coords.forEach(pt=>{lons+=pt[0];lats+=pt[1];n++;});
    postalCentroids.set(f.properties.posnro, calcDistance(lons/n,lats/n,HELSINKI_CENTER[0],HELSINKI_CENTER[1]));
    postalNameMap.set(f.properties.posnro, f.properties.nimi);
  });
  setupUIHandlers();
  updateDataAndRender();
}).catch(err => console.error("Error loading data:", err));

// === AGGREGATION === //
function aggregateDataForYear(year) {
  currentDataMap.clear();
  const ys = String(year);
  const groups = d3.group(rawCsv.filter(d=>d.Year===ys), d=>d.PostalCode);
  groups.forEach((rows,pc) => {
    let tp=0,pc2=0,ts=0,pop=0,inc=0;
    rows.forEach(r => {
      const p=parseFloat(r['Price per square meter (EUR/m2)']);
      if(!isNaN(p)){tp+=p;pc2++;}
      const s=parseInt(r['Number of sales, asset transfer tax data starting from 2020']);
      if(!isNaN(s)) ts+=s;
      if(!pop){const v=parseInt(r.Population);if(!isNaN(v))pop=v;}
      if(!inc){const v=parseInt(r.AverageIncome);if(!isNaN(v))inc=v;}
    });
    if(pc2>0||ts>0) currentDataMap.set(pc,{price:pc2>0?tp/pc2:0,sales:ts,pop,income:inc,distance:postalCentroids.get(pc)||0});
  });
}

function getTimeSeriesForPC(pc) {
  const series = [];
  for (let y=2015; y<=2025; y++) {
    const ys=String(y);
    const rows = rawCsv.filter(r=>r.PostalCode===pc && r.Year===ys);
    let tp=0,pc2=0,ts=0,pop=0,inc=0;
    rows.forEach(r=>{
      const p=parseFloat(r['Price per square meter (EUR/m2)']);if(!isNaN(p)){tp+=p;pc2++;}
      const s=parseInt(r['Number of sales, asset transfer tax data starting from 2020']);if(!isNaN(s))ts+=s;
      if(!pop){const v=parseInt(r.Population);if(!isNaN(v))pop=v;}
      if(!inc){const v=parseInt(r.AverageIncome);if(!isNaN(v))inc=v;}
    });
    series.push({year:y, price:pc2>0?tp/pc2:null, sales:ts||null, pop, income:inc||null});
  }
  return series;
}

// === RENDER ORCHESTRATOR === //
function updateDataAndRender() {
  aggregateDataForYear(appState.year);
  renderLayers();
  renderAllCharts();
}

// === MAP LAYERS === //
function renderLayers() {
  const layers = [];
  layers.push(new deck.GeoJsonLayer({
    id:'postal-codes', data:geoPostalCodes, pickable:true,
    stroked:true, filled:true, extruded:appState.is3DExtruded, wireframe:true,
    elevationScale:10, getLineColor:[0,0,0,20], getLineWidth:2,
    getElevation: f => { const d=currentDataMap.get(f.properties.posnro); return d?d.sales*10:0; },
    getFillColor: f => {
      const pc=f.properties.posnro, d=currentDataMap.get(pc);
      const isSelected = appState.selectedAreas.has(pc);
      const hasSelections = appState.selectedAreas.size > 0;
      
      if (hasSelections && !isSelected) {
         if (pc === appState.hoveredPC) return (d && d.price > 0) ? [...getPriceColor(d.price), 255] : [200,200,200,150];
         return [0, 0, 0, 0];
      }
      
      if (pc === appState.hoveredPC) return [255,123,0,220]; // orange highlight on hover
      if (d && d.price > 0) return [...getPriceColor(d.price), 255];
      return [200,200,200,150];
    },
    getLineColor: f => {
      const pc = f.properties.posnro;
      if (appState.selectedAreas.size > 0 && !appState.selectedAreas.has(pc) && pc !== appState.hoveredPC) return [0,0,0,0];
      return [0,0,0,20];
    },
    updateTriggers:{
      getFillColor:[appState.year,appState.hoveredPC,appState.selectedAreas.size],
      getLineColor:[appState.hoveredPC,appState.selectedAreas.size],
      getElevation:[appState.year],
      extruded:[appState.is3DExtruded]
    },
    transitions:{getElevation:400,getFillColor:300,getLineColor:300}
  }));
  if (appState.showCityPlans) {
    const filtered=geoCityPlans.features.filter(f=>parseInt(f.properties.vtulvuosi)===appState.year);
    if(filtered.length>0) layers.push(new deck.GeoJsonLayer({id:'city-plans',data:filtered,pickable:true,stroked:true,filled:true,getFillColor:[46,204,113,100],getLineColor:[39,174,96,255],getLineWidth:6,lineWidthMinPixels:2}));
  }
  if (appState.showHousingProd) {
    const filtered=geoHousingProd.features.filter(f=>f.properties.Valmistumisvuosi===appState.year);
    if(filtered.length>0) layers.push(new deck.GeoJsonLayer({id:'housing-prod',data:filtered,pickable:true,stroked:true,filled:true,pointRadiusMinPixels:3,pointRadiusMaxPixels:12,getFillColor:[241,196,15,230],getLineColor:[255,255,255,255],getPointRadius:30}));
  }
  deckgl.setProps({layers});
}

// === CHARTS === //
function getHelsinkiOverviewSeries() {
  const series = [];
  for (let y=2015; y<=2025; y++) {
    const ys=String(y);
    const rows = rawCsv.filter(r=>r.Year===ys);
    let tp=0,pc2=0,ts=0,totalPop=0,popCount=0,totalInc=0,incCount=0;
    const seenPC = new Set();
    rows.forEach(r=>{
      const p=parseFloat(r['Price per square meter (EUR/m2)']);if(!isNaN(p)){tp+=p;pc2++;}
      const s=parseInt(r['Number of sales, asset transfer tax data starting from 2020']);if(!isNaN(s))ts+=s;
      if(!seenPC.has(r.PostalCode)){
        seenPC.add(r.PostalCode);
        const v=parseInt(r.Population);if(!isNaN(v)){totalPop+=v;popCount++;}
        const vi=parseInt(r.AverageIncome);if(!isNaN(vi)){totalInc+=vi;incCount++;}
      }
    });
    series.push({year:y, price:pc2>0?tp/pc2:null, sales:ts||null, pop:totalPop, income:incCount>0?totalInc/incCount:null});
  }
  return series;
}

function renderAllCharts() {
  const panel = document.getElementById('analytics-panel');
  const title = document.getElementById('analytics-title');
  const hint = document.getElementById('analytics-hint');
  panel.classList.remove('hidden');

  if (appState.selectedAreas.size === 0) {
    title.textContent = '📊 Helsinki Metropolitan Overview';
    hint.textContent = 'Showing region-wide summary. Select specific areas above for comparison.';
  } else {
    const names = Array.from(appState.selectedAreas).map(pc => postalNameMap.get(pc)||pc).join(', ');
    title.textContent = '📊 Area Analytics';
    hint.textContent = names;
  }
  renderLineChart('chart-price-trend', 'price', '€/m²');
  renderBarChart('chart-sales-volume');
  renderLineChart('chart-income-trend', 'income', '€');
  renderScatterplot();
  renderTenureChart();
}

function renderLineChart(containerId, field, unit) {
  const container = d3.select('#'+containerId);
  container.selectAll('*').remove();
  const w = container.node().clientWidth || 300;
  const h = container.node().clientHeight || 130;
  const m={t:12,r:12,b:28,l:42}, iw=w-m.l-m.r, ih=h-m.t-m.b;
  const svg = container.append('svg').attr('viewBox',`0 0 ${w} ${h}`).append('g').attr('transform',`translate(${m.l},${m.t})`);

  const areas = Array.from(appState.selectedAreas);
  let allSeries;
  if (areas.length > 0) {
    allSeries = areas.map(pc => ({pc, data: getTimeSeriesForPC(pc).filter(d=>d[field]!=null)}));
  } else {
    allSeries = [{pc:'Helsinki Metro', data: getHelsinkiOverviewSeries().filter(d=>d[field]!=null)}];
  }
  const allVals = allSeries.flatMap(s=>s.data.map(d=>d[field]));
  if (!allVals.length) return;

  const x = d3.scaleLinear().domain([2015,2025]).range([0,iw]);
  const y = d3.scaleLinear().domain(d3.extent(allVals)).nice().range([ih,0]);

  svg.append('g').attr('class','axis').attr('transform',`translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickFormat(d3.format('d')));
  svg.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(5).tickFormat(v=>fmtK(v)));
  // grid
  svg.selectAll('.grid-line').data(y.ticks(5)).join('line').attr('class','grid-line').attr('x1',0).attr('x2',iw).attr('y1',d=>y(d)).attr('y2',d=>y(d));

  const line = d3.line().x(d=>x(d.year)).y(d=>y(d[field])).curve(d3.curveMonotoneX);
  const area = d3.area().x(d=>x(d.year)).y0(ih).y1(d=>y(d[field])).curve(d3.curveMonotoneX);

  // Draw ALL area fills first (bottom layer)
  allSeries.forEach((s,i) => {
    const color = getAreaColor(s.pc);
    svg.append('path').datum(s.data).attr('class','chart-area').attr('d',area).attr('fill',color);
  });
  // Then ALL lines (middle layer)
  allSeries.forEach((s,i) => {
    const color = getAreaColor(s.pc);
    svg.append('path').datum(s.data).attr('class','chart-line').attr('d',line).attr('stroke',color);
  });
  // Then ALL dots on top (interactive layer)
  allSeries.forEach((s,i) => {
    const color = getAreaColor(s.pc);
    svg.selectAll(null).data(s.data).join('circle').attr('class','chart-dot')
      .attr('cx',d=>x(d.year)).attr('cy',d=>y(d[field])).attr('r',3.5).attr('fill',color)
      .on('mouseenter', function(ev,d) { showChartTip(ev,`${postalNameMap.get(s.pc)||s.pc}: ${unit==='€/m²'?'€':'€'}${Math.round(d[field]).toLocaleString()}${unit==='€/m²'?'/m²':''} (${d.year})`); })
      .on('mouseleave', hideChartTip);
  });
  // year indicator line
  svg.append('line').attr('x1',x(appState.year)).attr('x2',x(appState.year)).attr('y1',0).attr('y2',ih).attr('stroke','#ff007b').attr('stroke-width',1.5).attr('stroke-dasharray','4,3').attr('opacity',0.6);
}

function renderBarChart(containerId) {
  const container = d3.select('#'+containerId);
  container.selectAll('*').remove();
  const w = container.node().clientWidth || 300;
  const h = container.node().clientHeight || 130;
  const m={t:12,r:12,b:28,l:42}, iw=w-m.l-m.r, ih=h-m.t-m.b;
  const svg = container.append('svg').attr('viewBox',`0 0 ${w} ${h}`).append('g').attr('transform',`translate(${m.l},${m.t})`);

  const areas = Array.from(appState.selectedAreas);
  let allSeries, seriesKeys;
  if (areas.length > 0) {
    allSeries = areas.map(pc => ({pc, data: getTimeSeriesForPC(pc)}));
    seriesKeys = areas;
  } else {
    allSeries = [{pc:'Helsinki Metro', data: getHelsinkiOverviewSeries()}];
    seriesKeys = ['Helsinki Metro'];
  }
  const years = d3.range(2015,2026);

  const x0 = d3.scaleBand().domain(years).range([0,iw]).padding(0.2);
  const x1 = d3.scaleBand().domain(seriesKeys).range([0,x0.bandwidth()]).padding(0.05);
  const allVals = allSeries.flatMap(s=>s.data.map(d=>d.sales||0));
  const y = d3.scaleLinear().domain([0,d3.max(allVals)||1]).nice().range([ih,0]);

  svg.append('g').attr('class','axis').attr('transform',`translate(0,${ih})`).call(d3.axisBottom(x0).tickFormat(d=>String(d).slice(2)));
  svg.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(5).tickFormat(v=>fmtK(v)));

  allSeries.forEach(s => {
    const color = getAreaColor(s.pc);
    svg.selectAll(null).data(s.data).join('rect').attr('class','bar-rect')
      .attr('x',d=>x0(d.year)+x1(s.pc)).attr('y',d=>y(d.sales||0)).attr('width',x1.bandwidth()).attr('height',d=>ih-y(d.sales||0))
      .attr('fill',color).attr('rx',2)
      .on('mouseenter',(ev,d)=>showChartTip(ev,`${postalNameMap.get(s.pc)||s.pc}: ${d.sales||0} sales (${d.year})`))
      .on('mouseleave',hideChartTip);
  });
  svg.append('line').attr('x1',x0(appState.year)+x0.bandwidth()/2).attr('x2',x0(appState.year)+x0.bandwidth()/2).attr('y1',0).attr('y2',ih).attr('stroke','#ff007b').attr('stroke-width',1.5).attr('stroke-dasharray','4,3').attr('opacity',0.6);
}

function renderScatterplot() {
  const container = d3.select('#scatterplot');
  container.selectAll('*').remove();
  const w = container.node().clientWidth || 300;
  const h = container.node().clientHeight || 130;
  const m={t:12,r:12,b:32,l:42}, iw=w-m.l-m.r, ih=h-m.t-m.b;
  const svg = container.append('svg').attr('viewBox',`0 0 ${w} ${h}`).append('g').attr('transform',`translate(${m.l},${m.t})`);

  const data = Array.from(currentDataMap.entries()).map(([pc,d])=>({pc,...d})).filter(d=>d.price>0);
  let xAcc, xLabel;
  if (appState.scatterMetric==='price_vs_income') { xAcc=d=>d.income; xLabel='Avg Income (€)'; }
  else if (appState.scatterMetric==='price_vs_pop') { xAcc=d=>d.pop; xLabel='Population'; }
  else { xAcc=d=>d.distance; xLabel='Dist. to Center (km)'; }
  const plotData = data.filter(d=>xAcc(d)>0);
  if (!plotData.length) return;

  const popExtent = d3.extent(plotData, d=>d.pop);
  const rScale = d3.scaleSqrt().domain([popExtent[0]||1, popExtent[1]||1]).range([3,14]);

  const x = d3.scaleLinear().domain(d3.extent(plotData,xAcc)).nice().range([0,iw]);
  const y = d3.scaleLinear().domain(d3.extent(plotData,d=>d.price)).nice().range([ih,0]);

  svg.append('g').attr('class','axis').attr('transform',`translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickFormat(v=>fmtK(v)));
  svg.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(5).tickFormat(v=>fmtK(v)));
  // axis labels
  svg.append('text').attr('x',iw/2).attr('y',ih+28).attr('text-anchor','middle').attr('fill','#94a3b8').attr('font-size',9).text(xLabel);
  svg.append('text').attr('transform','rotate(-90)').attr('x',-ih/2).attr('y',-34).attr('text-anchor','middle').attr('fill','#94a3b8').attr('font-size',9).text('Price (€/m²)');
  // grid
  svg.selectAll('.grid-line').data(y.ticks(5)).join('line').attr('class','grid-line').attr('x1',0).attr('x2',iw).attr('y1',d=>y(d)).attr('y2',d=>y(d));

  svg.selectAll('circle').data(plotData).join('circle')
    .attr('class', d => {
      let cls = 'scatter-dot';
      if (appState.hoveredPC && d.pc!==appState.hoveredPC) cls += ' dimmed';
      if (appState.hoveredPC && d.pc===appState.hoveredPC) cls += ' highlighted';
      if (appState.selectedAreas.size>0 && appState.selectedAreas.has(d.pc)) cls += ' highlighted';
      return cls;
    })
    .attr('cx',d=>x(xAcc(d))).attr('cy',d=>y(d.price))
    .attr('r', d=>rScale(d.pop||1))
    .attr('fill', d => {
      if (appState.selectedAreas.has(d.pc)) return getAreaColor(d.pc);
      return `rgb(${getPriceColor(d.price).join(',')})`;
    })
    .on('mouseenter', function(ev,d) {
      setHoveredPC(d.pc);
      showChartTip(ev,`${d.pc} ${postalNameMap.get(d.pc)||''}\nPrice: €${Math.round(d.price).toLocaleString()}/m²\nPop: ${d.pop.toLocaleString()}`);
    })
    .on('mouseleave', function() { setHoveredPC(null); hideChartTip(); });
}

function highlightScatterDot(pc) {
  d3.selectAll('.scatter-dot')
    .classed('dimmed', d => pc && d.pc!==pc)
    .classed('highlighted', d => pc && d.pc===pc);
}

// Chart tooltip helpers
let tipEl = null;
function showChartTip(ev, text) {
  if (!tipEl) { tipEl=document.createElement('div'); tipEl.className='chart-tooltip'; document.body.appendChild(tipEl); }
  tipEl.innerHTML = text.replace(/\n/g,'<br>');
  tipEl.classList.add('visible');
  tipEl.style.left = (ev.pageX+12)+'px';
  tipEl.style.top = (ev.pageY-10)+'px';
}
function hideChartTip() { if(tipEl) tipEl.classList.remove('visible'); }

// === TENURE DATA (loaded from CSV) === //
function loadTenureData() {
  d3.csv('./data/tenure_data.csv').then(rows => {
    rows.forEach(r => {
      const area = r.AreaCode;
      const year = parseInt(r.Year);
      if (!area || isNaN(year)) return;
      if (!tenureData.has(area)) tenureData.set(area, new Map());
      tenureData.get(area).set(year, {
        owner: parseFloat(r.OwnerPct) || 0,
        rental: parseFloat(r.RentalPct) || 0,
        subsidized: parseFloat(r.SubsidizedPct) || 0
      });
    });
    console.log(`Tenure data loaded: ${tenureData.size} areas`);
    renderTenureChart(); // re-render with real data
  }).catch(err => {
    console.warn('Tenure data CSV not found, using synthetic fallback:', err);
    generateTenureDataFallback();
  });
}

function generateTenureDataFallback() {
  // Synthetic fallback if CSV is missing
  const allPCs = new Set();
  rawCsv.forEach(r => allPCs.add(r.PostalCode));
  allPCs.forEach(pc => {
    const pcData = new Map();
    for (let y = 2015; y <= 2025; y++) {
      const hash = parseInt(pc) || 0;
      const ownerBase = 30 + (hash % 40);
      const rentalBase = 20 + ((hash * 7) % 30);
      const remain = 100 - ownerBase - rentalBase;
      const drift = (y - 2015) * 0.3;
      const owner = Math.max(10, ownerBase - drift);
      const rental = Math.min(80, rentalBase + drift * 0.7);
      const subsidized = Math.max(3, remain + drift * 0.3);
      const total = owner + rental + subsidized;
      pcData.set(y, {
        owner: Math.round(owner / total * 100),
        rental: Math.round(rental / total * 100),
        subsidized: Math.round(subsidized / total * 100)
      });
    }
    tenureData.set(pc, pcData);
  });
}

function getTenureForPC(pc, year) {
  // Direct postal code lookup (if available)
  const pcData = tenureData.get(pc);
  if (pcData) return pcData.get(year) || null;
  
  // Map postal codes to city-level tenure data:
  // 00xxx => Helsinki (091), 01xxx => Vantaa (092), 02xxx => Espoo (049)
  let cityCode = null;
  const pcNum = parseInt(pc);
  if (pcNum >= 0 && pcNum < 1000) cityCode = '091'; // Helsinki  
  else if (pcNum >= 1000 && pcNum < 2000) cityCode = '092'; // Vantaa
  else if (pcNum >= 2000 && pcNum < 3000) cityCode = '049'; // Espoo
  
  if (cityCode) {
    const cityData = tenureData.get(cityCode);
    if (cityData) return cityData.get(year) || null;
  }
  return null;
}

function getHelsinkiTenureOverview(year) {
  // Use the PKS (Capital Region) or Helsinki city-level data
  // Look for "PKS" (Pääkaupunkiseutu = Capital Region)
  const pksNames = ['PKS', 'Pääkaupunkiseutu', 'P\u00e4\u00e4kaupunkiseutu', 'P��kaupunkiseutu'];
  for (const name of pksNames) {
    const pksData = tenureData.get(name);
    if (pksData) {
      const d = pksData.get(year);
      if (d) return d;
    }
  }
  // Fallback: average across all city-level entries
  let totalOwner = 0, totalRental = 0, totalSub = 0, count = 0;
  ['091', '049', '092', '235'].forEach(code => {
    const cityData = tenureData.get(code);
    if (cityData) {
      const d = cityData.get(year);
      if (d) { totalOwner += d.owner; totalRental += d.rental; totalSub += d.subsidized; count++; }
    }
  });
  if (count === 0) return { owner: 45, rental: 42, subsidized: 13 };
  return {
    owner: Math.round(totalOwner / count),
    rental: Math.round(totalRental / count),
    subsidized: Math.round(totalSub / count)
  };
}

function renderTenureChart() {
  const container = d3.select('#chart-tenure');
  container.selectAll('*').remove();
  const w = container.node().clientWidth || 300;
  const h = container.node().clientHeight || 130;
  const m = {t:12, r:12, b:28, l:42}, iw = w-m.l-m.r, ih = h-m.t-m.b;
  const svg = container.append('svg').attr('viewBox',`0 0 ${w} ${h}`).append('g').attr('transform',`translate(${m.l},${m.t})`);

  const areas = Array.from(appState.selectedAreas);
  const years = d3.range(2015, 2026);
  
  // Get tenure series — for overview or selected area
  let seriesData;
  if (areas.length === 0) {
    seriesData = years.map(y => ({ year: y, ...getHelsinkiTenureOverview(y) }));
  } else {
    // Average across selected areas
    seriesData = years.map(y => {
      let o=0, r=0, s=0, c=0;
      areas.forEach(pc => {
        const d = getTenureForPC(pc, y);
        if (d) { o += d.owner; r += d.rental; s += d.subsidized; c++; }
      });
      return { year: y, owner: c?Math.round(o/c):0, rental: c?Math.round(r/c):0, subsidized: c?Math.round(s/c):0 };
    });
  }

  const x = d3.scaleBand().domain(years).range([0, iw]).padding(0.15);
  const y = d3.scaleLinear().domain([0, 100]).range([ih, 0]);
  const categories = ['owner', 'rental', 'subsidized'];
  const colors = { owner: '#3b82f6', rental: '#f59e0b', subsidized: '#10b981' };
  const labels = { owner: 'Owner', rental: 'Rental', subsidized: 'Subsidized' };

  svg.append('g').attr('class','axis').attr('transform',`translate(0,${ih})`).call(d3.axisBottom(x).tickFormat(d=>String(d).slice(2)));
  svg.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(5).tickFormat(d=>d+'%'));
  // Grid
  svg.selectAll('.grid-line').data(y.ticks(5)).join('line').attr('class','grid-line').attr('x1',0).attr('x2',iw).attr('y1',d=>y(d)).attr('y2',d=>y(d));

  // Stacked bars
  seriesData.forEach(d => {
    let cumY = 0;
    categories.forEach(cat => {
      const val = d[cat] || 0;
      svg.append('rect')
        .attr('x', x(d.year))
        .attr('y', y(cumY + val))
        .attr('width', x.bandwidth())
        .attr('height', y(cumY) - y(cumY + val))
        .attr('fill', colors[cat])
        .attr('rx', 1)
        .on('mouseenter', (ev) => showChartTip(ev, `${d.year}: ${labels[cat]} ${val}%`))
        .on('mouseleave', hideChartTip);
      cumY += val;
    });
  });

  // Year indicator
  const yearX = x(appState.year);
  if (yearX !== undefined) {
    svg.append('line').attr('x1',yearX+x.bandwidth()/2).attr('x2',yearX+x.bandwidth()/2).attr('y1',0).attr('y2',ih).attr('stroke','#ff007b').attr('stroke-width',1.5).attr('stroke-dasharray','4,3').attr('opacity',0.6);
  }

  // Mini legend
  const legendG = svg.append('g').attr('transform',`translate(${iw-90},2)`);
  categories.forEach((cat, i) => {
    legendG.append('rect').attr('x',0).attr('y',i*12).attr('width',8).attr('height',8).attr('fill',colors[cat]).attr('rx',2);
    legendG.append('text').attr('x',11).attr('y',i*12+8).attr('fill','#64748b').attr('font-size',8).text(labels[cat]);
  });
}

// === UI HANDLERS === //
function setupUIHandlers() {
  const slider=document.getElementById('year-slider'), label=document.getElementById('year-label');
  const metricSel=document.getElementById('metric-select');
  const tCity=document.getElementById('toggle-city-plans'), tProd=document.getElementById('toggle-housing-prod'), t3D=document.getElementById('toggle-3d');
  const searchInput=document.getElementById('area-search'), searchResults=document.getElementById('search-results');
  const btnPrev=document.getElementById('year-prev'), btnNext=document.getElementById('year-next');

  // Timeline slider
  slider.addEventListener('input', e=>{ appState.year=parseInt(e.target.value); label.innerText=appState.year; updateDataAndRender(); });
  
  // Timeline prev/next buttons
  if (btnPrev) btnPrev.addEventListener('click', () => {
    if (appState.year > 2015) { appState.year--; slider.value=appState.year; label.innerText=appState.year; updateDataAndRender(); }
  });
  if (btnNext) btnNext.addEventListener('click', () => {
    if (appState.year < 2025) { appState.year++; slider.value=appState.year; label.innerText=appState.year; updateDataAndRender(); }
  });

  metricSel.addEventListener('change', e=>{ appState.scatterMetric=e.target.value; renderScatterplot(); });
  tCity.addEventListener('change', e=>{ appState.showCityPlans=e.target.checked; renderLayers(); });
  tProd.addEventListener('change', e=>{ appState.showHousingProd=e.target.checked; renderLayers(); });
  t3D.addEventListener('change', e=>{ appState.is3DExtruded=e.target.checked; renderLayers(); });

  searchInput.addEventListener('input', e=>{
    const term=e.target.value.toLowerCase().trim();
    if(!term||!geoPostalCodes){searchResults.style.display='none';return;}
    const matches=geoPostalCodes.features.filter(f=>f.properties.posnro.includes(term)||(f.properties.nimi&&f.properties.nimi.toLowerCase().includes(term))).slice(0,10);
    if(matches.length>0){
      searchResults.innerHTML=matches.map(f=>`<div class="dropdown-item" data-pc="${f.properties.posnro}" data-name="${f.properties.nimi}">${f.properties.posnro} — ${f.properties.nimi}</div>`).join('');
      searchResults.style.display='block';
    } else { searchResults.innerHTML='<div class="dropdown-item">No results</div>'; searchResults.style.display='block'; }
  });

  searchResults.addEventListener('click', e=>{
    const item=e.target.closest('.dropdown-item'); if(!item) return;
    const pc=item.getAttribute('data-pc');
    if(pc) toggleAreaSelection(pc);
    searchInput.value=''; searchResults.style.display='none';
  });
  document.addEventListener('click', e=>{ if(e.target!==searchInput&&e.target!==searchResults) searchResults.style.display='none'; });
  window.addEventListener('resize', ()=>{ renderAllCharts(); });

  // Load tenure data from CSV (real data from PxWeb API)
  loadTenureData();
}
