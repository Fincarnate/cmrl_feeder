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
                        'is_hub_stop', sp.is_hub_stop,
                        'verification_status',sp.verification_status,
                        'coordinate_source',sp.coordinate_source
                    ) ORDER BY sp.point_name
                ) FILTER (WHERE sp.point_id IS NOT NULL),
                '[]'::json
            ) AS pickup_points

        FROM service_zone sz
        JOIN metro_station ms
          ON ms.station_id = sz.station_id

        LEFT JOIN service_point sp
          ON sp.zone_id = sz.zone_id
         AND sp.is_active = TRUE
         AND sp.verification_status = 'VERIFIED'
         AND sp.location_coords IS NOT NULL
         AND ST_Covers(sz.boundary_polygon, sp.location_coords)

        WHERE ms.is_active = TRUE
          AND sz.is_active = TRUE
          AND ms.service_area_polygon IS NOT NULL
          AND sz.boundary_polygon IS NOT NULL
          AND sz.center_coords IS NOT NULL
          AND ST_Covers(ms.service_area_polygon,sz.center_coords)
          AND ST_Covers(
              sz.boundary_polygon,
              ST_SetSRID(ST_MakePoint($1, $2), 4326)
          )

        GROUP BY
            ms.station_id, ms.station_name, ms.feeder_bay_number,
            sz.zone_id, sz.zone_name, sz.zone_type,
            sz.distance_to_metro_km

        ORDER BY ms.station_name, sz.zone_name;
    `;

    const result = await pool.query(query, [longitude, latitude]);
    return result.rows;
}

async function createServiceRequest(data) {
    const query = `
        INSERT INTO service_request (
            user_id, request_type, trip_direction,
            station_id, zone_id, residential_point_id,
            source_description, destination_description,
            source_latitude, source_longitude,
            destination_latitude, destination_longitude,
            seats_requested
        )
        SELECT
            $1, $2, $3, ms.station_id, sz.zone_id, $6,
            $7, $8, $9, $10, $11, $12, $13
        FROM service_zone sz
        JOIN metro_station ms
          ON ms.station_id = sz.station_id
        WHERE sz.zone_id = $5
          AND ms.station_id = $4
          AND ms.is_active = TRUE
          AND sz.is_active = TRUE
          AND ms.service_area_polygon IS NOT NULL
          AND sz.boundary_polygon IS NOT NULL
          AND sz.center_coords IS NOT NULL
          AND ST_Covers(ms.service_area_polygon,sz.center_coords)
          AND (
              $6::uuid IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM service_point sp
                  WHERE sp.point_id = $6
                    AND sp.zone_id = sz.zone_id
                    AND sp.is_active = TRUE
                    AND sp.verification_status='VERIFIED'
                    AND sp.location_coords IS NOT NULL
                    AND ST_Covers(sz.boundary_polygon, sp.location_coords)
              )
          )
          AND (
              $3 <> 'RESIDENTIAL_TO_METRO'
              OR (
                  $9::double precision IS NOT NULL
                  AND $10::double precision IS NOT NULL
                  AND ST_Covers(
                      sz.boundary_polygon,
                      ST_SetSRID(ST_MakePoint($10, $9), 4326)
                  )
              )
          )
          AND (
              $3 <> 'METRO_TO_RESIDENTIAL'
              OR (
                  $11::double precision IS NOT NULL
                  AND $12::double precision IS NOT NULL
                  AND ST_Covers(
                      sz.boundary_polygon,
                      ST_SetSRID(ST_MakePoint($12, $11), 4326)
                  )
              )
          )
        RETURNING *;
    `;

    const values = [
        data.userId,
        data.requestType,
        data.direction,
        data.stationId,
        data.zoneId,
        data.residentialPointId,
        data.sourceDescription,
        data.destinationDescription,
        data.sourceLatitude,
        data.sourceLongitude,
        data.destinationLatitude,
        data.destinationLongitude,
        data.seatsRequested
    ];

    const result = await pool.query(query, values);
    return result.rows[0] || null;
}

async function findRequestById(requestId, userId) {
    const result = await pool.query(
        `SELECT *
         FROM service_request
         WHERE request_id = $1 AND user_id = $2`,
        [requestId, userId]
    );

    return result.rows[0] || null;
}

module.exports = {
    findServiceOptionsForLocation,
    createServiceRequest,
    findRequestById
};
