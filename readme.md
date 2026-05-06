# Helsinki Housing Insights Dashboard

A course project for **Interactive Data Visualization (Spring 2026)**, University of Helsinki.

## Overview

An interactive geospatial dashboard for exploring Helsinki's housing market (2015–2025). Built with **Deck.gl**, **MapLibre GL**, and **D3.js**.

**Features:**
- Bivariate choropleth map (color = price/m², optional 3D height = sales volume)
- Click-to-select areas on the map or search by postal code / name
- Timeline slider (2015–2025) with step buttons
- Five coordinated analytics charts: price trend, sales volume, income trend, market demographics scatterplot, housing tenure
- Overlay layers: housing production sites, new city plan boundaries
- Linked brushing between map and charts

## Data Sources

| Source | Provider |
|--------|----------|
| Housing transaction prices | [Statistics Finland PxWeb](https://pxdata.stat.fi) |
| Demographics (population, income) | [Paavo Open Data](https://pxdata.stat.fi) |
| Housing tenure composition | [Helsinki Region PxWeb](https://stat.hel.fi) |
| Postal code boundaries | Helsinki Region Infoshare (GeoJSON) |
| Housing production & city plans | Helsinki Open Data (GeoJSON) |

All datasets are published under the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) license by their respective providers. Attribution is required when redistributing or adapting the data.

## Getting Started

### 1. Start the dashboard

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

## Tech Stack

- **Map rendering:** Deck.gl 8.9 + MapLibre GL 3.6
- **Charts:** D3.js 7.8
- **Data pipeline:** Python 3 (pandas, requests)
- **No build step** — pure HTML/JS/CSS, served statically
