import { graphql } from "./client";

export const HTTPMetricsQuery = graphql(`
  query HTTPMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequests1mGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          uniq {
            uniques
          }
          sum {
            browserMap {
              pageViews
              uaBrowserFamily
            }
            bytes
            cachedBytes
            cachedRequests
            contentTypeMap {
              bytes
              requests
              edgeResponseContentTypeName
            }
            countryMap {
              bytes
              clientCountryName
              requests
              threats
            }
            encryptedBytes
            encryptedRequests
            pageViews
            requests
            responseStatusMap {
              edgeResponseStatus
              requests
            }
            threatPathingMap {
              requests
              threatPathingName
            }
            threats
            clientHTTPVersionMap {
              clientHTTPProtocol
              requests
            }
            clientSSLMap {
              clientSSLProtocol
              requests
            }
            ipClassMap {
              ipType
              requests
            }
          }
          dimensions {
            datetime
          }
        }
        firewallEventsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          dimensions {
            action
            source
            ruleId
            clientRequestHTTPHost
            clientCountryName
            botScore
            botScoreSrcName
          }
        }
      }
    }
  }
`);

export const HTTPMetricsQueryNoBots = graphql(`
  query HTTPMetricsNoBots(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequests1mGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          uniq {
            uniques
          }
          sum {
            browserMap {
              pageViews
              uaBrowserFamily
            }
            bytes
            cachedBytes
            cachedRequests
            contentTypeMap {
              bytes
              requests
              edgeResponseContentTypeName
            }
            countryMap {
              bytes
              clientCountryName
              requests
              threats
            }
            encryptedBytes
            encryptedRequests
            pageViews
            requests
            responseStatusMap {
              edgeResponseStatus
              requests
            }
            threatPathingMap {
              requests
              threatPathingName
            }
            threats
            clientHTTPVersionMap {
              clientHTTPProtocol
              requests
            }
            clientSSLMap {
              clientSSLProtocol
              requests
            }
            ipClassMap {
              ipType
              requests
            }
          }
          dimensions {
            datetime
          }
        }
        firewallEventsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          dimensions {
            action
            source
            ruleId
            clientRequestHTTPHost
            clientCountryName
          }
        }
      }
    }
  }
`);

export const FirewallMetricsQuery = graphql(`
  query FirewallMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        firewallEventsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          dimensions {
            action
            source
            ruleId
            clientRequestHTTPHost
            clientCountryName
          }
        }
      }
    }
  }
`);

export const HealthCheckMetricsQuery = graphql(`
  query HealthCheckMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        healthCheckEventsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          avg {
            rttMs
            timeToFirstByteMs
            tcpConnMs
            tlsHandshakeMs
          }
          dimensions {
            healthStatus
            originIP
            region
            fqdn
            failureReason
          }
        }
      }
    }
  }
`);

export const AdaptiveMetricsQuery = graphql(`
  query AdaptiveMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequestsAdaptiveGroups(
          limit: $limit
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            cacheStatus_notin: ["hit"]
            originResponseStatus_in: [
              400
              404
              500
              502
              503
              504
              522
              523
              524
            ]
          }
        ) {
          count
          dimensions {
            originResponseStatus
            clientCountryName
            clientRequestHTTPHost
          }
          avg {
            originResponseDurationMs
          }
        }
      }
    }
  }
`);

export const EdgeCountryMetricsQuery = graphql(`
  query EdgeCountryMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequestsEdgeCountryHost: httpRequestsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          dimensions {
            edgeResponseStatus
            clientCountryName
            clientRequestHTTPHost
          }
        }
      }
    }
  }
`);

export const ColoMetricsQuery = graphql(`
  query ColoMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequestsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          avg {
            sampleInterval
          }
          dimensions {
            clientRequestHTTPHost
            coloCode
            datetime
            originResponseStatus
          }
          sum {
            edgeResponseBytes
            visits
          }
        }
      }
    }
  }
`);

export const ColoErrorMetricsQuery = graphql(`
  query ColoErrorMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequestsAdaptiveGroups(
          limit: $limit
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            edgeResponseStatus_geq: 400
          }
        ) {
          count
          dimensions {
            clientRequestHTTPHost
            coloCode
            edgeResponseStatus
          }
          sum {
            edgeResponseBytes
            visits
          }
        }
      }
    }
  }
`);

export const WorkerTotalsQuery = graphql(`
  query WorkerTotals(
    $accountID: string!
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        workersInvocationsAdaptive(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          dimensions {
            scriptName
            status
          }
          sum {
            requests
            errors
            duration
          }
          quantiles {
            cpuTimeP50
            cpuTimeP75
            cpuTimeP99
            cpuTimeP999
            durationP50
            durationP75
            durationP99
            durationP999
          }
        }
      }
    }
  }
`);

// Note: Cloudflare's accounts filter only supports single accountTag, not accountTag_in
// Use WorkerTotalsQuery for individual account queries

export const LoadBalancerMetricsQuery = graphql(`
  query LoadBalancerMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        loadBalancingRequestsAdaptiveGroups(
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
          limit: $limit
        ) {
          count
          dimensions {
            lbName
            selectedPoolName
            selectedOriginName
            region
            proxied
            selectedPoolAvgRttMs
            selectedPoolHealthy
            steeringPolicy
            numberOriginsSelected
          }
        }
        loadBalancingRequestsAdaptive(
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
          limit: $limit
        ) {
          lbName
          pools {
            id
            poolName
            healthy
            healthCheckEnabled
            avgRttMs
          }
        }
      }
    }
  }
`);

export const LogpushAccountMetricsQuery = graphql(`
  query LogpushAccountMetrics(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        logpushHealthAdaptiveGroups(
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            status_neq: 200
          }
          limit: $limit
        ) {
          count
          dimensions {
            jobId
            status
            destinationType
            datetime
            final
          }
        }
      }
    }
  }
`);

// Note: Cloudflare's accounts filter only supports single accountTag, not accountTag_in
// Use LogpushAccountMetricsQuery for individual account queries

export const LogpushZoneMetricsQuery = graphql(`
  query LogpushZoneMetrics(
    $zoneIDs: [string!]
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        logpushHealthAdaptiveGroups(
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            status_neq: 200
          }
          limit: $limit
        ) {
          count
          dimensions {
            jobId
            status
            destinationType
            datetime
            final
          }
        }
      }
    }
  }
`);

export const MagicTransitMetricsQuery = graphql(`
  query MagicTransitMetrics(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        magicTransitTunnelHealthChecksAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          avg {
            tunnelState
          }
          dimensions {
            active
            datetime
            edgeColoCity
            edgeColoCountry
            edgePopName
            remoteTunnelIPv4
            resultStatus
            siteName
            tunnelName
          }
        }
      }
    }
  }
`);

// Note: Cloudflare's accounts filter only supports single accountTag, not accountTag_in
// Use MagicTransitMetricsQuery for individual account queries

export const MagicTransitSLOMetricsQuery = graphql(`
  query MagicTransitSLOMetrics(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        magicTransitTunnelHealthCheckSLOsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          avg {
            effectiveSlo
            slo
          }
          dimensions {
            tunnelName
            siteName
            status
          }
        }
      }
    }
  }
`);

export const MagicTransitTunnelTrafficQuery = graphql(`
  query MagicTransitTunnelTraffic(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        magicTransitTunnelTrafficAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            tunnelName
            direction
            onRamp
            offRamp
          }
        }
      }
    }
  }
`);

export const MagicFirewallSamplesQuery = graphql(`
  query MagicFirewallSamples(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        magicFirewallSamplesAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            ruleId
          }
        }
      }
    }
  }
`);

export const RequestMethodMetricsQuery = graphql(`
  query RequestMethodMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequestsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          dimensions {
            clientRequestHTTPMethodName
          }
        }
      }
    }
  }
`);

export const OriginStatusMetricsQuery = graphql(`
  query OriginStatusMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequestsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          dimensions {
            originResponseStatus
            clientCountryName
            clientRequestHTTPHost
          }
        }
      }
    }
  }
`);

export const HostnameHttpMetricsQuery = graphql(`
  query HostnameHttpMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
    $hosts: [string!]
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag

        hostRequests: httpRequestsAdaptiveGroups(
          limit: $limit
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            clientRequestHTTPHost_in: $hosts
          }
        ) {
          count
          dimensions {
            clientRequestHTTPHost
          }
        }

        hostStatus: httpRequestsAdaptiveGroups(
          limit: $limit
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            clientRequestHTTPHost_in: $hosts
          }
        ) {
          count
          dimensions {
            clientRequestHTTPHost
            edgeResponseStatus
          }
        }

        hostCache: httpRequestsAdaptiveGroups(
          limit: $limit
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            clientRequestHTTPHost_in: $hosts
          }
        ) {
          count
          dimensions {
            clientRequestHTTPHost
            cacheStatus
          }
        }

        hostLatency: httpRequestsAdaptiveGroups(
          limit: $limit
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            clientRequestHTTPHost_in: $hosts
          }
        ) {
          dimensions {
            clientRequestHTTPHost
          }
          avg {
            edgeTimeToFirstByteMs
            originResponseDurationMs
          }
          quantiles {
            edgeTimeToFirstByteMsP50
            edgeTimeToFirstByteMsP95
            originResponseDurationMsP50
            originResponseDurationMsP95
          }
        }
      }
    }
  }
`);

export const CacheMissMetricsQuery = graphql(`
  query CacheMissMetrics(
    $zoneIDs: [string!]
    $mintime: Time!
    $maxtime: Time!
    $limit: uint64!
  ) {
    viewer {
      zones(filter: { zoneTag_in: $zoneIDs }) {
        zoneTag
        httpRequestsAdaptiveGroups(
          filter: {
            datetime_geq: $mintime
            datetime_lt: $maxtime
            cacheStatus: "miss"
          }
          limit: $limit
        ) {
          count
          avg {
            originResponseDurationMs
          }
          dimensions {
            clientCountryName
            clientRequestHTTPHost
          }
        }
      }
    }
  }
`);

/**
 * Combined network analytics query across all 6 NAv2 datasets.
 * Returns bits/packets totals with low-cardinality dimensions.
 * Datasets that don't apply to an account return empty arrays.
 */
export const NetworkAnalyticsQuery = graphql(`
  query NetworkAnalytics(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        magicTransitNetworkAnalyticsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            outcome
            direction
            ipProtocolName
            mitigationSystem
          }
        }
        magicFirewallNetworkAnalyticsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            outcome
            direction
            ipProtocolName
          }
        }
        dosdNetworkAnalyticsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            outcome
            direction
            ipProtocolName
            attackVector
          }
        }
        magicIDPSNetworkAnalyticsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            outcome
            direction
            ipProtocolName
          }
        }
        advancedTcpProtectionNetworkAnalyticsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            outcome
            direction
            ipProtocolName
          }
        }
        advancedDnsProtectionNetworkAnalyticsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          sum {
            bits
            packets
          }
          dimensions {
            outcome
            direction
            ipProtocolName
          }
        }
      }
    }
  }
`);

/**
 * Cloudflare Stream video playback metrics.
 * Groups minutes viewed by country and media type.
 * uid and creator are intentionally omitted (high cardinality).
 */
export const StreamVideoPlaybackQuery = graphql(`
  query StreamVideoPlayback(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        streamMinutesViewedAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          sum {
            minutesViewed
          }
          dimensions {
            clientCountryName
            mediaType
          }
        }
      }
    }
  }
`);

/**
 * Cloudflare Stream live input (input stream) metrics.
 * Groups segment counts and bit rate by event code.
 * inputId is intentionally omitted (high cardinality).
 */
export const StreamLiveInputsQuery = graphql(`
  query StreamLiveInputs(
    $accountID: string!
    $limit: uint64!
    $mintime: Time!
    $maxtime: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountID }) {
        liveInputEventsAdaptiveGroups(
          limit: $limit
          filter: { datetime_geq: $mintime, datetime_lt: $maxtime }
        ) {
          count
          avg {
            bitRate
            gopDuration
            uploadDurationRatio
          }
          dimensions {
            eventCode
          }
        }
      }
    }
  }
`);
