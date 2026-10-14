// Find the valid service zones for a passenger's residential location.
// Coordinates must be supplied as latitude and longitude.

const pool = require("../pool");

async function findServiceOptionsForLocation(latitude, longitude) {
    const query = `
        SELECT
            ms.station_id,
            ms.station_name,
            ms.feeder_bay_number,

            sz.zone_id,
            sz.zone_name,
            sz.zone_type,
            sz.distance_to_metro_km,

            COALESCE(
                json_agg(
                    json_build_object(
                        'point_id', sp.point_id,
                        'point_name', sp.point_name,
                        'road_access_status', sp.road_access_status,
                        'is_hub_stop', sp.is_hub_stop
                    )
                    ORDER BY sp.point_name
                ) FILTER (WHERE sp.point_id IS NOT NULL),
                '[]'::json
            ) AS pickup_points

        FROM service_zone AS sz

        JOIN metro_station AS ms
            ON ms.station_id = sz.station_id

        LEFT JOIN service_point AS sp
            ON sp.zone_id = sz.zone_id
           AND sp.is_active = TRUE
           AND sp.location_coords IS NOT NULL
           AND ST_Covers(
                sz.boundary_polygon,
                sp.location_coords
           )

        WHERE ms.is_active = TRUE
          AND sz.is_active = TRUE

          -- Both boundary polygons must exist.
          AND ms.service_boundary_polygon IS NOT NULL
          AND sz.boundary_polygon IS NOT NULL

          -- The entire residential zone must lie inside
          -- its metro station's service boundary.
          AND ST_Covers(
                ms.service_boundary_polygon,
                sz.boundary_polygon
          )

          -- The passenger's residential location must
          -- lie inside that residential zone.
          AND ST_Covers(
                sz.boundary_polygon,
                ST_SetSRID(
                    ST_MakePoint($1, $2),
                    4326
                )
          )

        GROUP BY
            ms.station_id,
            ms.station_name,
            ms.feeder_bay_number,
            sz.zone_id,
            sz.zone_name,
            sz.zone_type,
            sz.distance_to_metro_km

        ORDER BY
            ms.station_name,
            sz.zone_name;
    `;

    // PostGIS point order is longitude first, latitude second.
    const result = await pool.query(query, [longitude, latitude]);

    return result.rows;
}

module.exports = {
    findServiceOptionsForLocation
};
